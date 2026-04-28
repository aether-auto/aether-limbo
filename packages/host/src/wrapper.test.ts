import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { IClaudeDetector, StateListener } from "./detector/types.js";
import { NullOverlayController } from "./hotkey/overlay-stub.js";
import type { IHotkeyInterceptor, IOverlayController } from "./hotkey/types.js";
import { DEFAULT_TABS } from "./overlay/types.js";
import type { IDisposable, IPty, PtyExit, PtySpawnOptions } from "./pty/types.js";
import { _defaultRegistryForTest, runWrapper } from "./wrapper.js";

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

  it("forwards SIGWINCH to the overlay too — but only while it is open", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout(80, 24);
    const proc = new EventEmitter();
    let captured: MockPty | undefined;
    const factory = vi.fn((opts: PtySpawnOptions): IPty => {
      captured = new MockPty(opts);
      return captured;
    });
    const overlay = new NullOverlayController();
    const promise = runWrapper({
      claudeBin: "/fake/claude",
      argv: [],
      env: {},
      cwd: "/tmp",
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      process: proc as unknown as NodeJS.Process,
      ptyFactory: factory,
      overlay,
    });
    if (!captured) throw new Error("factory not invoked synchronously");
    stdout.columns = 132;
    stdout.rows = 50;
    proc.emit("SIGWINCH");
    expect(overlay.resizes).toEqual([]);
    overlay.open();
    proc.emit("SIGWINCH");
    expect(overlay.resizes).toEqual([{ cols: 132, rows: 50 }]);
    captured.emitExit({ exitCode: 0 });
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

  it("routes stdin bytes through the hotkey interceptor and only forwards passthrough", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const proc = new EventEmitter();
    let captured: MockPty | undefined;
    const factory = vi.fn((opts: PtySpawnOptions): IPty => {
      captured = new MockPty(opts);
      return captured;
    });
    const seen: string[] = [];
    const recording: IHotkeyInterceptor = {
      feed(chunk: string): string {
        seen.push(chunk);
        return chunk.split("\x0c").join("");
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
      interceptor: recording,
    });
    if (!captured) throw new Error("factory not invoked synchronously");
    stdin.emit("data", Buffer.from("hi\x0c!"));
    expect(seen).toEqual(["hi\x0c!"]);
    expect(captured.writes).toEqual(["hi!"]);
    captured.emitExit({ exitCode: 0 });
    await promise;
  });

  it("does not call pty.write when the interceptor swallows every byte", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const proc = new EventEmitter();
    let captured: MockPty | undefined;
    const factory = vi.fn((opts: PtySpawnOptions): IPty => {
      captured = new MockPty(opts);
      return captured;
    });
    const swallow: IHotkeyInterceptor = { feed: () => "" };
    const promise = runWrapper({
      claudeBin: "/fake/claude",
      argv: [],
      env: {},
      cwd: "/tmp",
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      process: proc as unknown as NodeJS.Process,
      ptyFactory: factory,
      interceptor: swallow,
    });
    if (!captured) throw new Error("factory not invoked synchronously");
    stdin.emit("data", Buffer.from("\x0c"));
    expect(captured.writes).toEqual([]);
    captured.emitExit({ exitCode: 0 });
    await promise;
  });

  it("exposes the wired interceptor via onInterceptor when defaults are used", async () => {
    const onInterceptor = vi.fn();
    const { pty, promise } = setup();
    pty.emitExit({ exitCode: 0 });
    await promise;
    // setup() does not pass onInterceptor, so verify a separate run does.
    const stdin2 = makeStdin();
    const stdout2 = makeStdout();
    const proc2 = new EventEmitter();
    let captured: MockPty | undefined;
    const factory = vi.fn((opts: PtySpawnOptions): IPty => {
      captured = new MockPty(opts);
      return captured;
    });
    const promise2 = runWrapper({
      claudeBin: "/fake/claude",
      argv: [],
      env: {},
      cwd: "/tmp",
      stdin: stdin2,
      stdout: stdout2 as unknown as NodeJS.WriteStream,
      process: proc2 as unknown as NodeJS.Process,
      ptyFactory: factory,
      onInterceptor,
    });
    if (!captured) throw new Error("factory not invoked synchronously");
    expect(onInterceptor).toHaveBeenCalledOnce();
    captured.emitExit({ exitCode: 0 });
    await promise2;
  });

  it("routes stdin to the overlay (not the PTY) while overlay.isOpen()", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const proc = new EventEmitter();
    let captured: MockPty | undefined;
    const factory = vi.fn((opts: PtySpawnOptions): IPty => {
      captured = new MockPty(opts);
      return captured;
    });
    const overlay = new NullOverlayController();
    overlay.open();
    const promise = runWrapper({
      claudeBin: "/fake/claude",
      argv: [],
      env: {},
      cwd: "/tmp",
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      process: proc as unknown as NodeJS.Process,
      ptyFactory: factory,
      overlay,
    });
    if (!captured) throw new Error("factory not invoked synchronously");
    stdin.emit("data", Buffer.from("hjkl"));
    expect(overlay.inputs).toEqual(["hjkl"]);
    expect(captured.writes).toEqual([]);
    captured.emitExit({ exitCode: 0 });
    await promise;
  });

  it("routes stdin back to the PTY once the overlay closes", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const proc = new EventEmitter();
    let captured: MockPty | undefined;
    const factory = vi.fn((opts: PtySpawnOptions): IPty => {
      captured = new MockPty(opts);
      return captured;
    });
    const overlay = new NullOverlayController();
    overlay.open();
    const promise = runWrapper({
      claudeBin: "/fake/claude",
      argv: [],
      env: {},
      cwd: "/tmp",
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      process: proc as unknown as NodeJS.Process,
      ptyFactory: factory,
      overlay,
    });
    if (!captured) throw new Error("factory not invoked synchronously");
    stdin.emit("data", Buffer.from("hi"));
    expect(captured.writes).toEqual([]);
    overlay.close();
    stdin.emit("data", Buffer.from("there"));
    expect(captured.writes).toEqual(["there"]);
    captured.emitExit({ exitCode: 0 });
    await promise;
  });

  it("closes a still-open overlay when the PTY exits", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const proc = new EventEmitter();
    let captured: MockPty | undefined;
    const factory = vi.fn((opts: PtySpawnOptions): IPty => {
      captured = new MockPty(opts);
      return captured;
    });
    const overlay = new NullOverlayController();
    overlay.open();
    const promise = runWrapper({
      claudeBin: "/fake/claude",
      argv: [],
      env: {},
      cwd: "/tmp",
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      process: proc as unknown as NodeJS.Process,
      ptyFactory: factory,
      overlay,
    });
    if (!captured) throw new Error("factory not invoked synchronously");
    expect(overlay.isOpen()).toBe(true);
    captured.emitExit({ exitCode: 0 });
    await promise;
    expect(overlay.isOpen()).toBe(false);
    expect(overlay.closes).toBe(1);
  });

  it("exposes the wired overlay via onOverlay when defaults are used", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const proc = new EventEmitter();
    let captured: MockPty | undefined;
    const factory = vi.fn((opts: PtySpawnOptions): IPty => {
      captured = new MockPty(opts);
      return captured;
    });
    let received: IOverlayController | undefined;
    const promise = runWrapper({
      claudeBin: "/fake/claude",
      argv: [],
      env: {},
      cwd: "/tmp",
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      process: proc as unknown as NodeJS.Process,
      ptyFactory: factory,
      onOverlay: (o) => {
        received = o;
      },
    });
    if (!captured) throw new Error("factory not invoked synchronously");
    expect(received).toBeDefined();
    expect(received?.isOpen()).toBe(false);
    captured.emitExit({ exitCode: 0 });
    await promise;
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

  it("appends the __echo tab when LIMBO_DEBUG_ECHO=1 is in the environment", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const proc = new EventEmitter();
    let captured: MockPty | undefined;
    const factory = vi.fn((opts: PtySpawnOptions): IPty => {
      captured = new MockPty(opts);
      return captured;
    });
    let receivedOverlay: IOverlayController | undefined;
    const promise = runWrapper({
      claudeBin: "/fake/claude",
      argv: [],
      env: { LIMBO_DEBUG_ECHO: "1" },
      cwd: "/tmp",
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      process: proc as unknown as NodeJS.Process,
      ptyFactory: factory,
      onOverlay: (o) => {
        receivedOverlay = o;
      },
    });
    if (!captured) throw new Error("factory not invoked synchronously");
    expect(receivedOverlay).toBeDefined();
    receivedOverlay?.open();
    expect(stdout.written.join("")).toContain("Echo");
    receivedOverlay?.close();
    captured.emitExit({ exitCode: 0 });
    await promise;
  });

  it("omits the __echo tab when LIMBO_DEBUG_ECHO is unset", async () => {
    const { stdout, pty, promise } = setup();
    // setup() passes `env: { PATH: "/usr/bin" }` — LIMBO_DEBUG_ECHO is absent
    expect(stdout.written.join("")).not.toContain(" Echo ");
    pty.emitExit({ exitCode: 0 });
    await promise;
  });
});

describe("defaultRegistry", () => {
  it("lists adapter ids in order: instagram-reels, instagram-feed, instagram-dms, twitter-home, tiktok-foryou, echo", () => {
    const registry = _defaultRegistryForTest({ PATH: "/usr/bin" }, "/tmp");
    const ids = registry.list().map((d) => d.id);
    expect(ids).toEqual([
      "instagram-reels",
      "instagram-feed",
      "instagram-dms",
      "twitter-home",
      "tiktok-foryou",
      "echo",
    ]);
  });

  it('the tiktok-foryou descriptor has extras: ["tiktok"]', () => {
    const registry = _defaultRegistryForTest({ PATH: "/usr/bin" }, "/tmp");
    const tiktok = registry.list().find((d) => d.id === "tiktok-foryou");
    expect(tiktok).toBeDefined();
    expect(tiktok?.extras).toEqual(["tiktok"]);
  });

  it('all instagram-* descriptors have extras: ["instagram"]', () => {
    const registry = _defaultRegistryForTest({ PATH: "/usr/bin" }, "/tmp");
    const igDescriptors = registry.list().filter((d) => d.id.startsWith("instagram-"));
    expect(igDescriptors).toHaveLength(3);
    for (const d of igDescriptors) {
      expect(d.extras).toEqual(["instagram"]);
    }
  });

  it("the echo descriptor has extras: []", () => {
    const registry = _defaultRegistryForTest({ PATH: "/usr/bin" }, "/tmp");
    const echo = registry.list().find((d) => d.id === "echo");
    expect(echo).toBeDefined();
    expect(echo?.extras).toEqual([]);
  });
});

describe("runWrapper snap-back resize-poke", () => {
  it("calls pty.resize with current stdout dims when snap-back fires on an open overlay", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout(120, 40);
    const proc = new EventEmitter();
    let captured: MockPty | undefined;
    const factory = vi.fn((opts: PtySpawnOptions): IPty => {
      captured = new MockPty(opts);
      return captured;
    });

    const stateListeners: StateListener[] = [];
    let capturedOverlay: IOverlayController | undefined;

    const fakeDetector: IClaudeDetector = {
      feed() {},
      getState() {
        return "streaming" as const;
      },
      on(_event: "state", listener: StateListener) {
        stateListeners.push(listener);
        return { dispose: () => undefined };
      },
      dispose() {},
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
      detector: fakeDetector,
      onOverlay: (o) => {
        capturedOverlay = o;
      },
    });
    if (!captured) throw new Error("factory not invoked synchronously");

    capturedOverlay?.open();
    const resizesBefore = captured.resizes.length;

    for (const l of stateListeners) {
      l({ from: "streaming", to: "idle", atMs: 0 });
    }

    expect(captured.resizes.length).toBe(resizesBefore + 1);
    expect(captured.resizes[captured.resizes.length - 1]).toEqual({ cols: 120, rows: 40 });

    captured.emitExit({ exitCode: 0 });
    await promise;
  });

  it("does NOT call pty.resize when the overlay is closed at transition time", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout(120, 40);
    const proc = new EventEmitter();
    let captured: MockPty | undefined;
    const factory = vi.fn((opts: PtySpawnOptions): IPty => {
      captured = new MockPty(opts);
      return captured;
    });

    const stateListeners: StateListener[] = [];

    const fakeDetector: IClaudeDetector = {
      feed() {},
      getState() {
        return "streaming" as const;
      },
      on(_event: "state", listener: StateListener) {
        stateListeners.push(listener);
        return { dispose: () => undefined };
      },
      dispose() {},
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
      detector: fakeDetector,
    });
    if (!captured) throw new Error("factory not invoked synchronously");

    // overlay is never opened — transition should be a no-op
    const resizesBefore = captured.resizes.length;
    for (const l of stateListeners) {
      l({ from: "streaming", to: "idle", atMs: 0 });
    }

    expect(captured.resizes.length).toBe(resizesBefore);

    captured.emitExit({ exitCode: 0 });
    await promise;
  });
});

describe("DEFAULT_TABS", () => {
  it("the first three default tabs bind to instagram adapter ids", () => {
    expect(DEFAULT_TABS[0]?.adapterId).toBe("instagram-reels");
    expect(DEFAULT_TABS[1]?.adapterId).toBe("instagram-feed");
    expect(DEFAULT_TABS[2]?.adapterId).toBe("instagram-dms");
  });

  it("the X tab binds to twitter-home and the TikTok tab binds to tiktok-foryou", () => {
    expect(DEFAULT_TABS[3]?.adapterId).toBe("twitter-home");
    expect(DEFAULT_TABS[4]?.adapterId).toBe("tiktok-foryou");
  });
});
