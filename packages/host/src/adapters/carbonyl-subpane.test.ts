import { describe, expect, it, vi } from "vitest";
import type { IDisposable, IPty, PtyExit, PtyFactory, PtySpawnOptions } from "../pty/types.js";
import { CarbonylSubpane } from "./carbonyl-subpane.js";

// ---------------------------------------------------------------------------
// Fake PTY
// ---------------------------------------------------------------------------

class FakePty implements IPty {
  readonly pid = 1234;
  cols: number;
  rows: number;

  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: PtyExit) => void> = [];

  resizeCalls: Array<{ cols: number; rows: number }> = [];
  killCalls: string[] = [];

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  onData(listener: (data: string) => void): IDisposable {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        this.dataListeners = this.dataListeners.filter((l) => l !== listener);
      },
    };
  }

  onExit(listener: (event: PtyExit) => void): IDisposable {
    this.exitListeners.push(listener);
    return {
      dispose: () => {
        this.exitListeners = this.exitListeners.filter((l) => l !== listener);
      },
    };
  }

  write(_data: string): void {
    /* no-op */
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killCalls.push(signal ?? "");
  }

  // Test helpers
  emit(chunk: string): void {
    for (const l of this.dataListeners) l(chunk);
  }

  emitExit(event: PtyExit): void {
    for (const l of this.exitListeners) l(event);
  }
}

// ---------------------------------------------------------------------------
// Fake stdout
// ---------------------------------------------------------------------------

interface FakeStdout {
  written: string[];
  write(c: string): boolean;
}

function makeStdout(): FakeStdout {
  const written: string[] = [];
  return {
    written,
    write(c) {
      written.push(c);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

function makeSubpane(opts: { top?: number; left?: number; cols?: number; rows?: number } = {}): {
  subpane: CarbonylSubpane;
  fakePty: FakePty;
  stdout: FakeStdout;
} {
  const top = opts.top ?? 10;
  const left = opts.left ?? 5;
  const cols = opts.cols ?? 20;
  const rows = opts.rows ?? 5;

  const fakePty = new FakePty(cols, rows);
  const factory: PtyFactory = (_spawnOpts: PtySpawnOptions) => fakePty;
  const stdout = makeStdout();

  const subpane = new CarbonylSubpane({
    stdout,
    ptyFactory: factory,
    carbonylBin: "/usr/bin/carbonyl",
    url: "https://example.com",
    env: {},
    cwd: "/tmp",
    top,
    left,
    cols,
    rows,
  });

  return { subpane, fakePty, stdout };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CarbonylSubpane", () => {
  // Test 1: relayChunk rewrites a single CUP sequence
  it("relayChunk rewrites single CUP — \\x1b[1;1Hhi → \\x1b[10;5H with save/restore", () => {
    const { fakePty, stdout } = makeSubpane({ top: 10, left: 5 });
    fakePty.emit("\x1b[1;1Hhi");
    const out = stdout.written.join("");
    expect(out).toContain("\x1b[10;5H");
    expect(out).toContain("hi");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape boundary
    expect(out).toMatch(/^\x1b\[s/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape boundary
    expect(out).toMatch(/\x1b\[u$/);
  });

  // Test 2: relayChunk rewrites multiple CUPs
  it("relayChunk rewrites multiple CUPs (top=10 left=5)", () => {
    const { fakePty, stdout } = makeSubpane({ top: 10, left: 5 });
    fakePty.emit("\x1b[1;1Ha\x1b[2;3Hb");
    const out = stdout.written.join("");
    expect(out).toContain("\x1b[10;5Ha");
    expect(out).toContain("\x1b[11;7Hb");
  });

  // Test 3: relayChunk translates VPA
  it("relayChunk translates VPA — \\x1b[5d + top=10 → \\x1b[14d", () => {
    const { fakePty, stdout } = makeSubpane({ top: 10, left: 5 });
    fakePty.emit("\x1b[5d");
    const out = stdout.written.join("");
    expect(out).toContain("\x1b[14d");
  });

  // Test 4: relayChunk translates bare CUP (no args)
  it("relayChunk translates bare CUP \\x1b[H → \\x1b[10;5H", () => {
    const { fakePty, stdout } = makeSubpane({ top: 10, left: 5 });
    fakePty.emit("\x1b[H");
    const out = stdout.written.join("");
    expect(out).toContain("\x1b[10;5H");
  });

  // Test 5: relayChunk drops CSI 2J and writes blank-padded rows
  it("relayChunk drops \\x1b[2J and writes blank-padded rows", () => {
    const { fakePty, stdout } = makeSubpane({ top: 10, left: 5, cols: 20, rows: 3 });
    fakePty.emit("\x1b[2J");
    const out = stdout.written.join("");
    // Must NOT contain the raw ED escape
    expect(out).not.toContain("\x1b[2J");
    // Must contain blank rows positioned at top rows
    expect(out).toContain(`\x1b[10;5H${" ".repeat(20)}`);
    expect(out).toContain(`\x1b[11;5H${" ".repeat(20)}`);
    expect(out).toContain(`\x1b[12;5H${" ".repeat(20)}`);
  });

  // Test 6: relayChunk passes SGR and relative moves through unchanged
  it("relayChunk passes SGR and relative moves through unchanged", () => {
    const { fakePty, stdout } = makeSubpane({ top: 10, left: 5 });
    const input = "\x1b[31mhello\x1b[0m\x1b[Aup\x1b[Bdown";
    fakePty.emit(input);
    const out = stdout.written.join("");
    expect(out).toContain("\x1b[31m");
    expect(out).toContain("hello");
    expect(out).toContain("\x1b[0m");
    expect(out).toContain("\x1b[A");
    expect(out).toContain("\x1b[B");
  });

  // Test 7: resize calls pty.resize
  it("resize(cols, rows) calls pty.resize exactly once with new dimensions", () => {
    const { subpane, fakePty } = makeSubpane({ cols: 20, rows: 5 });
    subpane.resize(40, 10);
    expect(fakePty.resizeCalls).toHaveLength(1);
    expect(fakePty.resizeCalls[0]).toEqual({ cols: 40, rows: 10 });
  });

  // Test 8: kill writes blank rows and calls pty.kill('SIGTERM')
  it("kill() writes blank sub-rect and calls pty.kill('SIGTERM')", () => {
    const { subpane, fakePty, stdout } = makeSubpane({ top: 10, left: 5, cols: 20, rows: 3 });
    subpane.kill();
    const out = stdout.written.join("");
    // Each of the rows should be blanked
    expect(out).toContain(`\x1b[10;5H${" ".repeat(20)}`);
    expect(out).toContain(`\x1b[11;5H${" ".repeat(20)}`);
    expect(out).toContain(`\x1b[12;5H${" ".repeat(20)}`);
    // Must call kill with SIGTERM
    expect(fakePty.killCalls).toContain("SIGTERM");
  });

  // Test 9: onExit fires when pty exits
  it("onExit(handler) fires when the underlying fake pty emits exit", () => {
    const { subpane, fakePty } = makeSubpane();
    const handler = vi.fn();
    subpane.onExit(handler);
    fakePty.emitExit({ exitCode: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ exitCode: 0 });
  });

  // Test 10: multiple onExit handlers all fire
  it("multiple onExit handlers all fire", () => {
    const { subpane, fakePty } = makeSubpane();
    const h1 = vi.fn();
    const h2 = vi.fn();
    subpane.onExit(h1);
    subpane.onExit(h2);
    fakePty.emitExit({ exitCode: 1, signal: 15 });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  // Bonus: onExit returns a disposable that can be used to detach
  it("onExit returns IDisposable — disposed handler does not fire", () => {
    const { subpane, fakePty } = makeSubpane();
    const handler = vi.fn();
    const disposable = subpane.onExit(handler);
    disposable.dispose();
    fakePty.emitExit({ exitCode: 0 });
    expect(handler).not.toHaveBeenCalled();
  });

  // Bonus: chunk without absolute CUP gets an initial position prepended
  it("chunk without absolute CUP gets initial position prepended after save", () => {
    const { fakePty, stdout } = makeSubpane({ top: 10, left: 5 });
    fakePty.emit("\x1b[31mplain text\x1b[0m");
    const out = stdout.written.join("");
    // Should have: \x1b[s\x1b[10;5H<content>\x1b[u
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape boundary
    expect(out).toMatch(/^\x1b\[s\x1b\[10;5H/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape boundary
    expect(out).toMatch(/\x1b\[u$/);
  });

  // resize with top/left updates them
  it("resize with top and left updates internal offset for future chunks", () => {
    const { subpane, fakePty, stdout } = makeSubpane({ top: 10, left: 5, cols: 20, rows: 5 });
    subpane.resize(20, 5, 3, 2);
    fakePty.emit("\x1b[1;1Hx");
    const out = stdout.written.join("");
    expect(out).toContain("\x1b[3;2Hx");
  });

  // HVP (CSI f) is treated same as CUP (CSI H)
  it("relayChunk rewrites HVP (CSI f) the same as CUP", () => {
    const { fakePty, stdout } = makeSubpane({ top: 10, left: 5 });
    fakePty.emit("\x1b[2;3f");
    const out = stdout.written.join("");
    expect(out).toContain("\x1b[11;7f");
  });
});
