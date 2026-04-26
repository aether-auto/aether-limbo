import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { IClaudeDetector } from "./detector/types.js";
import type { IDisposable, IPty, PtyExit, PtySpawnOptions } from "./pty/types.js";
import { runWrapper } from "./wrapper.js";

class MockPty implements IPty {
  pid = 4242;
  cols: number;
  rows: number;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  readonly kills: Array<string | undefined> = [];
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<(e: PtyExit) => void> = [];

  constructor(opts: PtySpawnOptions) {
    this.cols = opts.cols;
    this.rows = opts.rows;
  }

  onData(l: (d: string) => void): IDisposable {
    this.dataListeners.push(l);
    return { dispose: () => undefined };
  }
  onExit(l: (e: PtyExit) => void): IDisposable {
    this.exitListeners.push(l);
    return { dispose: () => undefined };
  }
  write(d: string): void {
    this.writes.push(d);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
    this.cols = cols;
    this.rows = rows;
  }
  kill(signal?: string): void {
    this.kills.push(signal);
  }

  emitData(d: string): void {
    for (const l of this.dataListeners) l(d);
  }
  emitExit(e: PtyExit): void {
    for (const l of this.exitListeners) l(e);
  }
}

interface FakeStdin extends EventEmitter {
  isTTY: boolean;
  setRawMode: (raw: boolean) => FakeStdin;
}

function makeStdin(): FakeStdin {
  const e = new EventEmitter() as FakeStdin;
  e.isTTY = true;
  e.setRawMode = () => e;
  return e;
}

interface FakeStdout {
  columns: number;
  rows: number;
  write: (chunk: string) => boolean;
  written: string[];
}

function makeStdout(cols = 120, rows = 40): FakeStdout {
  const written: string[] = [];
  return {
    columns: cols,
    rows,
    write(chunk: string): boolean {
      written.push(chunk);
      return true;
    },
    written,
  };
}

function setup(initial?: { cols?: number; rows?: number }) {
  const stdin = makeStdin();
  const stdout = makeStdout(initial?.cols ?? 120, initial?.rows ?? 40);
  const proc = new EventEmitter();
  let captured: MockPty | undefined;
  const factory = vi.fn((opts: PtySpawnOptions): IPty => {
    captured = new MockPty(opts);
    return captured;
  });
  const promise = runWrapper({
    claudeBin: "/fake/claude",
    argv: ["--foo", "bar"],
    env: { PATH: "/usr/bin" },
    cwd: "/tmp",
    stdin,
    stdout: stdout as unknown as NodeJS.WriteStream,
    process: proc as unknown as NodeJS.Process,
    ptyFactory: factory,
  });
  if (!captured) throw new Error("factory not invoked synchronously");
  return { stdin, stdout, proc, factory, pty: captured, promise };
}

describe("runWrapper", () => {
  it("spawns the PTY with claudeBin, argv, env, cwd, and current tty size", async () => {
    const { factory, pty, promise } = setup({ cols: 100, rows: 30 });
    expect(factory).toHaveBeenCalledOnce();
    const opts = factory.mock.calls[0]?.[0] as PtySpawnOptions;
    expect(opts.file).toBe("/fake/claude");
    expect(opts.args).toEqual(["--foo", "bar"]);
    expect(opts.env).toEqual({ PATH: "/usr/bin" });
    expect(opts.cwd).toBe("/tmp");
    expect(opts.cols).toBe(100);
    expect(opts.rows).toBe(30);
    pty.emitExit({ exitCode: 0 });
    await promise;
  });

  it("forwards child output bytes to stdout untouched", async () => {
    const { stdout, pty, promise } = setup();
    pty.emitData("hello \x1b[31mworld\x1b[0m\n");
    pty.emitExit({ exitCode: 0 });
    await promise;
    expect(stdout.written.join("")).toBe("hello \x1b[31mworld\x1b[0m\n");
  });

  it("forwards stdin bytes to the child untouched", async () => {
    const { stdin, pty, promise } = setup();
    stdin.emit("data", Buffer.from("abc"));
    stdin.emit("data", Buffer.from("\r"));
    expect(pty.writes).toEqual(["abc", "\r"]);
    pty.emitExit({ exitCode: 0 });
    await promise;
  });

  it("forwards SIGWINCH by re-resizing the PTY to current stdout dims", async () => {
    const { stdout, proc, pty, promise } = setup({ cols: 80, rows: 24 });
    stdout.columns = 132;
    stdout.rows = 50;
    proc.emit("SIGWINCH");
    expect(pty.resizes).toEqual([{ cols: 132, rows: 50 }]);
    pty.emitExit({ exitCode: 0 });
    await promise;
  });

  it.each([["SIGINT"], ["SIGTERM"], ["SIGHUP"]])(
    "forwards %s to the child instead of dying itself",
    async (sigName) => {
      const { proc, pty, promise } = setup();
      proc.emit(sigName);
      expect(pty.kills).toEqual([sigName]);
      pty.emitExit({ exitCode: 0, signal: 2 });
      await promise;
    },
  );

  it("resolves with the translated exit code when the child exits normally", async () => {
    const { pty, promise } = setup();
    pty.emitExit({ exitCode: 7 });
    await expect(promise).resolves.toBe(7);
  });

  it("resolves with 128+signum when the child dies by signal", async () => {
    const { pty, promise } = setup();
    pty.emitExit({ exitCode: 0, signal: 2 });
    await expect(promise).resolves.toBe(130);
  });

  it("detaches stdin and signal listeners after the child exits", async () => {
    const { stdin, proc, pty, promise } = setup();
    pty.emitExit({ exitCode: 0 });
    await promise;
    expect(stdin.listenerCount("data")).toBe(0);
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGWINCH")).toBe(0);
  });

  it("a throwing detector never blocks pass-through to stdout", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const proc = new EventEmitter();
    let captured: MockPty | undefined;
    const factory = vi.fn((opts: PtySpawnOptions): IPty => {
      captured = new MockPty(opts);
      return captured;
    });
    const exploding: IClaudeDetector = {
      feed() {
        throw new Error("detector boom");
      },
      getState() {
        return "idle";
      },
      on() {
        return { dispose: () => undefined };
      },
      dispose() {
        return undefined;
      },
    };
    const promise = runWrapper({
      claudeBin: "/fake/claude",
      argv: [],
      env: {},
      cwd: "/tmp",
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      process: proc as unknown as NodeJS.Process,
      ptyFactory: factory,
      detector: exploding,
    });
    if (!captured) throw new Error("factory not invoked synchronously");
    expect(() => captured?.emitData("hello world\n")).not.toThrow();
    expect(stdout.written.join("")).toBe("hello world\n");
    captured.emitExit({ exitCode: 0 });
    await promise;
  });
});
