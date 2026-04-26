import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeState, IClaudeDetector, StateListener } from "../detector/types.js";
import type { IDisposable } from "../pty/types.js";
import { LimboOverlay } from "./overlay.js";
import { DEFAULT_TABS } from "./types.js";

class FakeDetector implements IClaudeDetector {
  private state: ClaudeState = "thinking";
  private readonly emitter = new EventEmitter();
  private disposed = false;

  feed(): void {
    /* unused */
  }
  getState(): ClaudeState {
    return this.state;
  }
  on(event: "state", listener: StateListener): IDisposable {
    this.emitter.on(event, listener);
    return { dispose: () => this.emitter.off(event, listener) };
  }
  dispose(): void {
    this.disposed = true;
  }

  setStateAndEmit(to: ClaudeState): void {
    const from = this.state;
    this.state = to;
    this.emitter.emit("state", { from, to, atMs: 0 });
  }

  listenerCount(): number {
    return this.emitter.listenerCount("state");
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

interface FakeStdout {
  columns: number;
  rows: number;
  write: (chunk: string) => boolean;
  buffer: string[];
}

function makeStdout(cols = 80, rows = 24): FakeStdout {
  const buffer: string[] = [];
  return {
    columns: cols,
    rows,
    write(chunk: string): boolean {
      buffer.push(chunk);
      return true;
    },
    buffer,
  };
}

function makeOverlay(rows = 24, cols = 80) {
  const detector = new FakeDetector();
  const stdout = makeStdout(cols, rows);
  const overlay = new LimboOverlay({ stdout, detector });
  return { detector, stdout, overlay };
}

describe("LimboOverlay lifecycle", () => {
  it("enters alt-screen, hides cursor, paints chrome on open()", () => {
    const { stdout, overlay } = makeOverlay();
    overlay.open();
    const out = stdout.buffer.join("");
    expect(out).toContain("\x1b[?1049h");
    expect(out).toContain("\x1b[?25l");
    expect(out).toContain(" Reels ");
    expect(out).toContain("state: thinking");
    expect(out).toContain("press Ctrl+L to return");
  });

  it("close() restores cursor and exits alt-screen with no extra leftover bytes", () => {
    const { stdout, overlay } = makeOverlay();
    overlay.open();
    stdout.buffer.length = 0;
    overlay.close();
    const out = stdout.buffer.join("");
    expect(out).toContain("\x1b[?25h");
    expect(out).toContain("\x1b[?1049l");
    expect(out.endsWith("\x1b[?1049l")).toBe(true);
  });

  it("isOpen() reflects open/close transitions and is idempotent", () => {
    const { overlay } = makeOverlay();
    expect(overlay.isOpen()).toBe(false);
    overlay.open();
    overlay.open();
    expect(overlay.isOpen()).toBe(true);
    overlay.close();
    overlay.close();
    expect(overlay.isOpen()).toBe(false);
  });

  it("subscribes to detector state events only while open", () => {
    const { detector, overlay } = makeOverlay();
    expect(detector.listenerCount()).toBe(0);
    overlay.open();
    expect(detector.listenerCount()).toBe(1);
    overlay.close();
    expect(detector.listenerCount()).toBe(0);
  });

  it("repaints the status line when Claude state transitions while open", () => {
    const { detector, stdout, overlay } = makeOverlay();
    overlay.open();
    stdout.buffer.length = 0;
    detector.setStateAndEmit("idle");
    expect(stdout.buffer.join("")).toContain("state: idle");
  });

  it("ignores state events fired after close()", () => {
    const { detector, stdout, overlay } = makeOverlay();
    overlay.open();
    overlay.close();
    stdout.buffer.length = 0;
    detector.setStateAndEmit("streaming");
    expect(stdout.buffer.join("")).toBe("");
  });

  it("handleResize() repaints chrome at the new dims while open", () => {
    const { stdout, overlay } = makeOverlay(24, 80);
    overlay.open();
    stdout.buffer.length = 0;
    stdout.columns = 132;
    stdout.rows = 50;
    overlay.handleResize(132, 50);
    const out = stdout.buffer.join("");
    expect(out).toContain(" Reels ");
    expect(out).toContain("state: thinking");
    // Status line is positioned by the LAST cursor-move sequence; it should target the new bottom row.
    expect(out).toContain("\x1b[50;1H");
  });

  it("handleResize() is a no-op when overlay is closed", () => {
    const { stdout, overlay } = makeOverlay();
    overlay.handleResize(132, 50);
    expect(stdout.buffer.join("")).toBe("");
  });
});

describe("LimboOverlay input handling", () => {
  it("h/l cycle the active tab and trigger a repaint", () => {
    const { stdout, overlay } = makeOverlay();
    overlay.open();
    stdout.buffer.length = 0;
    overlay.handleInput("l");
    const afterRight = stdout.buffer.join("");
    expect(afterRight).toContain("\x1b[7m Feed \x1b[0m");
    stdout.buffer.length = 0;
    overlay.handleInput("h");
    expect(stdout.buffer.join("")).toContain("\x1b[7m Reels \x1b[0m");
  });

  it("1..5 jumps to that tab", () => {
    const { stdout, overlay } = makeOverlay();
    overlay.open();
    stdout.buffer.length = 0;
    overlay.handleInput("3");
    const out = stdout.buffer.join("");
    const tab = DEFAULT_TABS[2];
    expect(tab).toBeDefined();
    expect(out).toContain(`\x1b[7m ${tab?.label} \x1b[0m`);
  });

  it("q closes the overlay", () => {
    const { overlay } = makeOverlay();
    overlay.open();
    overlay.handleInput("q");
    expect(overlay.isOpen()).toBe(false);
  });

  it("ignores input while closed", () => {
    const { stdout, overlay } = makeOverlay();
    overlay.handleInput("hjkl");
    expect(stdout.buffer.join("")).toBe("");
  });

  it("h on first tab wraps to the last tab", () => {
    const { stdout, overlay } = makeOverlay();
    overlay.open();
    stdout.buffer.length = 0;
    overlay.handleInput("h");
    const lastTab = DEFAULT_TABS[DEFAULT_TABS.length - 1];
    expect(lastTab).toBeDefined();
    expect(stdout.buffer.join("")).toContain(`\x1b[7m ${lastTab?.label} \x1b[0m`);
  });

  it("the keymap state is reset on close so a stale 'g' does not leak between sessions", () => {
    const { stdout, overlay } = makeOverlay();
    overlay.open();
    overlay.handleInput("g");
    overlay.close();
    overlay.open();
    stdout.buffer.length = 0;
    // After reopen, a single 'g' should remain a partial sequence; nothing repaints.
    overlay.handleInput("g");
    // No tab change implies no full repaint of the tab bar — tab bar only paints on open() or active-tab change.
    // The first 'g' here should NOT have triggered scroll-top as a leftover.
    overlay.handleInput("l");
    expect(stdout.buffer.join("")).toContain("\x1b[7m Feed \x1b[0m");
  });

  it("stops processing actions after a 'close' action in the same chunk", () => {
    const { overlay } = makeOverlay();
    overlay.open();
    const closeSpy = vi.spyOn(overlay, "close");
    overlay.handleInput("ql");
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(overlay.isOpen()).toBe(false);
  });
});
