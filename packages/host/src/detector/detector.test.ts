import { describe, expect, it } from "vitest";
import { ClaudeStateDetector } from "./detector.js";
import type { Clock, StateTransition } from "./types.js";

class FakeClock implements Clock {
  current = 0;
  private nextHandle = 1;
  private timers = new Map<NodeJS.Timeout, { fireAt: number; fn: () => void }>();

  now(): number {
    return this.current;
  }
  setTimeout(fn: () => void, ms: number): NodeJS.Timeout {
    const handle = this.nextHandle++ as unknown as NodeJS.Timeout;
    this.timers.set(handle, { fireAt: this.current + ms, fn });
    return handle;
  }
  clearTimeout(handle: NodeJS.Timeout): void {
    this.timers.delete(handle);
  }
  advance(ms: number): void {
    this.current += ms;
    for (const [h, t] of [...this.timers]) {
      if (t.fireAt <= this.current) {
        this.timers.delete(h);
        t.fn();
      }
    }
  }
}

function makeDetector(clock: FakeClock) {
  const transitions: StateTransition[] = [];
  const detector = new ClaudeStateDetector({ clock, debounceMs: 150 });
  detector.on("state", (t) => transitions.push(t));
  return { detector, transitions };
}

describe("ClaudeStateDetector", () => {
  it("starts in idle and reports idle", () => {
    const d = new ClaudeStateDetector({ clock: new FakeClock() });
    expect(d.getState()).toBe("idle");
  });

  it("transitions idle -> thinking on a spinner glyph in cursor-control context", () => {
    const clock = new FakeClock();
    const { detector, transitions } = makeDetector(clock);
    detector.feed("\r⠋ Thinking…");
    expect(detector.getState()).toBe("thinking");
    expect(transitions).toEqual([{ from: "idle", to: "thinking", atMs: 0 }]);
  });

  it("ignores a lone Braille glyph in user prose without cursor context", () => {
    const clock = new FakeClock();
    const { detector } = makeDetector(clock);
    detector.feed("Did you know ⠋ is U+280B in Unicode?\n");
    expect(detector.getState()).toBe("streaming");
  });

  it("detects spinner via frame cycling when no cursor context is present", () => {
    const clock = new FakeClock();
    const { detector, transitions } = makeDetector(clock);
    detector.feed("⠋");
    expect(detector.getState()).toBe("idle");
    clock.advance(80);
    detector.feed("⠙");
    expect(detector.getState()).toBe("thinking");
    expect(transitions.map((t) => t.to)).toEqual(["thinking"]);
  });

  it("recognizes ASCII star spinners with cursor-control context", () => {
    const clock = new FakeClock();
    const { detector } = makeDetector(clock);
    detector.feed("[2K\r✻ Working…");
    expect(detector.getState()).toBe("thinking");
  });

  it("transitions to tool_running when a tool marker appears", () => {
    const clock = new FakeClock();
    const { detector, transitions } = makeDetector(clock);
    detector.feed("\r⠋ Bash(ls -la)");
    expect(detector.getState()).toBe("tool_running");
    expect(transitions.map((t) => t.to)).toEqual(["tool_running"]);
  });

  it("re-classifies streaming -> tool_running mid-stream", () => {
    const clock = new FakeClock();
    const { detector, transitions } = makeDetector(clock);
    detector.feed("Let me check that file.\n");
    expect(detector.getState()).toBe("streaming");
    detector.feed("[2K\rRead(/etc/hosts)\n");
    expect(detector.getState()).toBe("tool_running");
    expect(transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      "idle->streaming",
      "streaming->tool_running",
    ]);
  });

  it("transitions to streaming for ordinary visible text without spinner/tool", () => {
    const clock = new FakeClock();
    const { detector } = makeDetector(clock);
    detector.feed("Here's a paragraph of plain assistant text.\n");
    expect(detector.getState()).toBe("streaming");
  });

  it("debounces back to idle after the configured quiet window once a prompt is seen", () => {
    const clock = new FakeClock();
    const { detector, transitions } = makeDetector(clock);
    detector.feed("Final answer text.\n");
    expect(detector.getState()).toBe("streaming");
    detector.feed("\n╭──────────────╮\n│ >            │\n╰──────────────╯\n");
    clock.advance(149);
    expect(detector.getState()).toBe("streaming");
    clock.advance(2);
    expect(detector.getState()).toBe("idle");
    expect(transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      "idle->streaming",
      "streaming->idle",
    ]);
  });

  it("uses a longer quiet window when no prompt sigil is visible", () => {
    const clock = new FakeClock();
    const { detector } = makeDetector(clock);
    detector.feed("\r⠙ Thinking…");
    clock.advance(150);
    expect(detector.getState()).toBe("thinking");
    clock.advance(450);
    expect(detector.getState()).toBe("idle");
  });

  it("re-arms the debounce on each chunk so streams stay 'streaming'", () => {
    const clock = new FakeClock();
    const { detector } = makeDetector(clock);
    for (let i = 0; i < 5; i++) {
      detector.feed(`tick ${i}\n`);
      clock.advance(100);
    }
    expect(detector.getState()).toBe("streaming");
  });

  it("ignores empty chunks", () => {
    const clock = new FakeClock();
    const { detector, transitions } = makeDetector(clock);
    detector.feed("");
    expect(transitions).toHaveLength(0);
    expect(detector.getState()).toBe("idle");
  });

  it("does not re-emit when the next chunk maps to the same state", () => {
    const clock = new FakeClock();
    const { detector, transitions } = makeDetector(clock);
    detector.feed("\r⠋ Thinking…");
    detector.feed("\r⠙ Thinking…");
    detector.feed("\r⠹ Thinking…");
    expect(transitions).toHaveLength(1);
  });

  it("dispose() removes listeners and stops further emits", () => {
    const clock = new FakeClock();
    const { detector, transitions } = makeDetector(clock);
    detector.dispose();
    detector.feed("\r⠋ Thinking…");
    clock.advance(1000);
    expect(transitions).toHaveLength(0);
  });

  it("on() returns a disposable that unsubscribes", () => {
    const clock = new FakeClock();
    const detector = new ClaudeStateDetector({ clock });
    const seen: StateTransition[] = [];
    const sub = detector.on("state", (t) => seen.push(t));
    detector.feed("\r⠋ Thinking…");
    sub.dispose();
    detector.feed("hello world");
    expect(seen).toHaveLength(1);
  });

  it("expires stale frames from the cycling window", () => {
    const clock = new FakeClock();
    const { detector } = makeDetector(clock);
    detector.feed("⠋");
    clock.advance(2000);
    detector.feed("⠙");
    expect(detector.getState()).toBe("idle");
  });
});
