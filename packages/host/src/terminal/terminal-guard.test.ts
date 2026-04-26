import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalGuard } from "./terminal-guard.js";

interface FakeStdin extends EventEmitter {
  isTTY: boolean;
  setRawMode: (raw: boolean) => FakeStdin;
  rawState: boolean;
}

function makeStdin(isTTY = true): FakeStdin {
  const e = new EventEmitter() as FakeStdin;
  e.isTTY = isTTY;
  e.rawState = false;
  e.setRawMode = (raw: boolean) => {
    e.rawState = raw;
    return e;
  };
  return e;
}

describe("TerminalGuard", () => {
  let proc: EventEmitter;
  let exitSpy: ReturnType<typeof vi.fn>;
  let stderrWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    proc = new EventEmitter();
    exitSpy = vi.fn();
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    proc.removeAllListeners();
    stderrWrite.mockRestore();
  });

  it("puts a TTY stdin into raw mode on enter and restores it on restore", () => {
    const stdin = makeStdin();
    const g = new TerminalGuard({ stdin, process: proc, exit: exitSpy });
    g.enter();
    expect(stdin.rawState).toBe(true);
    g.restore();
    expect(stdin.rawState).toBe(false);
  });

  it("is idempotent: a second enter or restore is a no-op", () => {
    const stdin = makeStdin();
    const g = new TerminalGuard({ stdin, process: proc, exit: exitSpy });
    g.enter();
    g.enter();
    g.restore();
    g.restore();
    expect(stdin.rawState).toBe(false);
  });

  it("does nothing to stdin when it is not a TTY", () => {
    const stdin = makeStdin(false);
    const setRaw = vi.spyOn(stdin, "setRawMode");
    const g = new TerminalGuard({ stdin, process: proc, exit: exitSpy });
    g.enter();
    g.restore();
    expect(setRaw).not.toHaveBeenCalled();
  });

  it("restores raw mode when the process emits 'exit'", () => {
    const stdin = makeStdin();
    const g = new TerminalGuard({ stdin, process: proc, exit: exitSpy });
    g.enter();
    proc.emit("exit");
    expect(stdin.rawState).toBe(false);
    g.restore();
  });

  it("on uncaughtException: restores raw mode and exits 1", () => {
    const stdin = makeStdin();
    const g = new TerminalGuard({ stdin, process: proc, exit: exitSpy });
    g.enter();
    proc.emit("uncaughtException", new Error("boom"));
    expect(stdin.rawState).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
