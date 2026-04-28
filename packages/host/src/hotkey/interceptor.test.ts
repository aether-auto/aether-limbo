import { describe, expect, it, vi } from "vitest";
import type { ClaudeState, StateTransition } from "../detector/types.js";
import type { IDisposable } from "../pty/types.js";
import { HotkeyInterceptor } from "./interceptor.js";
import { NullOverlayController } from "./overlay-stub.js";
import type { DetectorView, IShameRenderer } from "./types.js";

function makeDetector(state: ClaudeState): DetectorView {
  return { getState: () => state };
}

type StateListener = (t: StateTransition) => void;

interface FakeDetector extends DetectorView {
  emit(t: StateTransition): void;
}

function makeDetectorWithEvents(state: ClaudeState): FakeDetector {
  let listener: StateListener | undefined;
  return {
    getState: () => state,
    on(_event: "state", l: StateListener): IDisposable {
      listener = l;
      return {
        dispose: () => {
          listener = undefined;
        },
      };
    },
    emit(t: StateTransition): void {
      listener?.(t);
    },
  };
}

class FakeShame implements IShameRenderer {
  calls = 0;
  messages: Array<string | undefined> = [];
  showShame(message?: string): Promise<void> {
    this.calls++;
    this.messages.push(message);
    return Promise.resolve();
  }
}

describe("HotkeyInterceptor (default chord = Ctrl+L)", () => {
  it("forwards non-chord bytes verbatim", () => {
    const interceptor = new HotkeyInterceptor({
      detector: makeDetector("thinking"),
      overlay: new NullOverlayController(),
      shame: new FakeShame(),
    });
    expect(interceptor.feed("hello world")).toBe("hello world");
  });

  it("never forwards the chord byte to the child even amid other input", () => {
    const interceptor = new HotkeyInterceptor({
      detector: makeDetector("thinking"),
      overlay: new NullOverlayController(),
      shame: new FakeShame(),
    });
    expect(interceptor.feed("a\x0cb")).toBe("ab");
  });

  it("opens the overlay on chord press while Claude is thinking", () => {
    const overlay = new NullOverlayController();
    const interceptor = new HotkeyInterceptor({
      detector: makeDetector("thinking"),
      overlay,
      shame: new FakeShame(),
    });
    interceptor.feed("\x0c");
    expect(overlay.isOpen()).toBe(true);
    expect(overlay.opens).toBe(1);
  });

  it.each<ClaudeState>(["streaming", "tool_running", "thinking"])(
    "opens the overlay when state is %s",
    (state) => {
      const overlay = new NullOverlayController();
      const shame = new FakeShame();
      const interceptor = new HotkeyInterceptor({
        detector: makeDetector(state),
        overlay,
        shame,
      });
      interceptor.feed("\x0c");
      expect(overlay.isOpen()).toBe(true);
      expect(shame.calls).toBe(0);
    },
  );

  it("fires the shame banner and refuses to open the overlay when idle", () => {
    const overlay = new NullOverlayController();
    const shame = new FakeShame();
    const interceptor = new HotkeyInterceptor({
      detector: makeDetector("idle"),
      overlay,
      shame,
    });
    interceptor.feed("\x0c");
    expect(shame.calls).toBe(1);
    expect(overlay.isOpen()).toBe(false);
    expect(overlay.opens).toBe(0);
  });

  it("closes the overlay on a second chord press while open", () => {
    const overlay = new NullOverlayController();
    const shame = new FakeShame();
    const interceptor = new HotkeyInterceptor({
      detector: makeDetector("streaming"),
      overlay,
      shame,
    });
    interceptor.feed("\x0c");
    expect(overlay.isOpen()).toBe(true);
    interceptor.feed("\x0c");
    expect(overlay.isOpen()).toBe(false);
    expect(overlay.closes).toBe(1);
    expect(shame.calls).toBe(0);
  });

  it("handles two chord presses in a single chunk as open-then-close", () => {
    const overlay = new NullOverlayController();
    const interceptor = new HotkeyInterceptor({
      detector: makeDetector("streaming"),
      overlay,
      shame: new FakeShame(),
    });
    interceptor.feed("\x0c\x0c");
    expect(overlay.isOpen()).toBe(false);
    expect(overlay.opens).toBe(1);
    expect(overlay.closes).toBe(1);
  });

  it("a throwing detector cannot break the stdin path", () => {
    const overlay = new NullOverlayController();
    const onError = vi.fn();
    const interceptor = new HotkeyInterceptor({
      detector: {
        getState() {
          throw new Error("detector boom");
        },
      },
      overlay,
      shame: new FakeShame(),
      onError,
    });
    expect(() => interceptor.feed("\x0c")).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    expect(overlay.isOpen()).toBe(false);
  });

  it("a rejected shame promise is reported via onError instead of bubbling", async () => {
    const onError = vi.fn();
    const failingShame: IShameRenderer = {
      showShame: () => Promise.reject(new Error("flash boom")),
    };
    const interceptor = new HotkeyInterceptor({
      detector: makeDetector("idle"),
      overlay: new NullOverlayController(),
      shame: failingShame,
      onError,
    });
    interceptor.feed("\x0c");
    await Promise.resolve();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("HotkeyInterceptor with a custom multi-byte chord", () => {
  const F12 = "\x1b[24~";

  it("matches a multi-byte chord across split chunks and never forwards it", () => {
    const overlay = new NullOverlayController();
    const interceptor = new HotkeyInterceptor({
      detector: makeDetector("streaming"),
      overlay,
      shame: new FakeShame(),
      chord: F12,
    });
    expect(interceptor.feed("\x1b[24")).toBe("");
    expect(interceptor.feed("~")).toBe("");
    expect(overlay.isOpen()).toBe(true);
  });

  it("does not consume bytes that share only a partial prefix with the chord", () => {
    const overlay = new NullOverlayController();
    const interceptor = new HotkeyInterceptor({
      detector: makeDetector("streaming"),
      overlay,
      shame: new FakeShame(),
      chord: F12,
    });
    expect(interceptor.feed("\x1b[24x")).toBe("\x1b[24x");
    expect(overlay.isOpen()).toBe(false);
  });
});

describe("HotkeyInterceptor escalation", () => {
  it("default behaviour unchanged: 5 idle presses all use default message (no args)", () => {
    const shame = new FakeShame();
    const interceptor = new HotkeyInterceptor({
      detector: makeDetector("idle"),
      overlay: new NullOverlayController(),
      shame,
    });
    for (let i = 0; i < 5; i++) interceptor.feed("\x0c");
    expect(shame.calls).toBe(5);
    expect(shame.messages.every((m) => m === undefined)).toBe(true);
  });

  it("escalation engaged: presses 1-2 use default, press 3+ uses round-robin messages", () => {
    const shame = new FakeShame();
    const interceptor = new HotkeyInterceptor({
      detector: makeDetector("idle"),
      overlay: new NullOverlayController(),
      shame,
      escalation: { threshold: 3, messages: ["X", "Y"] },
    });
    // press 1 (count=1 < 3): default
    interceptor.feed("\x0c");
    expect(shame.messages[0]).toBeUndefined();
    // press 2 (count=2 < 3): default
    interceptor.feed("\x0c");
    expect(shame.messages[1]).toBeUndefined();
    // press 3 (count=3 >= 3, idx=(3-3)%2=0): "X"
    interceptor.feed("\x0c");
    expect(shame.messages[2]).toBe("X");
    // press 4 (count=4 >= 3, idx=(4-3)%2=1): "Y"
    interceptor.feed("\x0c");
    expect(shame.messages[3]).toBe("Y");
    // press 5 (count=5 >= 3, idx=(5-3)%2=0): "X"
    interceptor.feed("\x0c");
    expect(shame.messages[4]).toBe("X");
  });

  it("counter resets when overlay successfully opens (non-idle chord press)", () => {
    const shame = new FakeShame();
    let currentState: ClaudeState = "idle";
    const detector: DetectorView = { getState: () => currentState };
    const overlay = new NullOverlayController();
    const interceptor = new HotkeyInterceptor({
      detector,
      overlay,
      shame,
      escalation: { threshold: 3, messages: ["X", "Y"] },
    });
    // Accumulate 2 idle presses
    interceptor.feed("\x0c");
    interceptor.feed("\x0c");
    expect(shame.calls).toBe(2);
    // Switch to non-idle, open overlay → resets counter
    currentState = "streaming";
    interceptor.feed("\x0c");
    expect(overlay.isOpen()).toBe(true);
    // Close overlay, switch back to idle
    interceptor.feed("\x0c");
    expect(overlay.isOpen()).toBe(false);
    currentState = "idle";
    // Counter was reset; press 1 (count=1) → default
    interceptor.feed("\x0c");
    expect(shame.messages[2]).toBeUndefined();
    // press 2 (count=2) → default
    interceptor.feed("\x0c");
    expect(shame.messages[3]).toBeUndefined();
    // press 3 (count=3 >= 3, idx=0) → "X" (not continuing from before)
    interceptor.feed("\x0c");
    expect(shame.messages[4]).toBe("X");
  });

  it("counter resets on detector state transition to non-idle via event", () => {
    const shame = new FakeShame();
    const detector = makeDetectorWithEvents("idle");
    const interceptor = new HotkeyInterceptor({
      detector,
      overlay: new NullOverlayController(),
      shame,
      escalation: { threshold: 3, messages: ["X", "Y"] },
    });
    // Accumulate 2 idle presses
    interceptor.feed("\x0c");
    interceptor.feed("\x0c");
    expect(shame.calls).toBe(2);
    // Emit a state transition to non-idle → counter resets
    detector.emit({ from: "idle", to: "streaming", atMs: 0 });
    // Now press 3 times — first 2 should be default (counter was reset to 0)
    interceptor.feed("\x0c");
    expect(shame.messages[2]).toBeUndefined(); // count=1 < threshold
    interceptor.feed("\x0c");
    expect(shame.messages[3]).toBeUndefined(); // count=2 < threshold
    interceptor.feed("\x0c");
    expect(shame.messages[4]).toBe("X"); // count=3 >= threshold
  });

  it("state transition to idle does NOT reset counter", () => {
    const shame = new FakeShame();
    const detector = makeDetectorWithEvents("idle");
    const interceptor = new HotkeyInterceptor({
      detector,
      overlay: new NullOverlayController(),
      shame,
      escalation: { threshold: 3, messages: ["X"] },
    });
    interceptor.feed("\x0c");
    interceptor.feed("\x0c");
    // Emit idle→idle (to===idle): should not reset
    detector.emit({ from: "streaming", to: "idle", atMs: 0 });
    // count is still 2, press 3 → idx=0 "X"
    interceptor.feed("\x0c");
    expect(shame.messages[2]).toBe("X");
  });

  it("no escalation when escalation option is not provided", () => {
    const shame = new FakeShame();
    const interceptor = new HotkeyInterceptor({
      detector: makeDetector("idle"),
      overlay: new NullOverlayController(),
      shame,
    });
    for (let i = 0; i < 5; i++) interceptor.feed("\x0c");
    expect(shame.messages.every((m) => m === undefined)).toBe(true);
  });

  it("no escalation when threshold is 0", () => {
    const shame = new FakeShame();
    const interceptor = new HotkeyInterceptor({
      detector: makeDetector("idle"),
      overlay: new NullOverlayController(),
      shame,
      escalation: { threshold: 0, messages: ["X"] },
    });
    for (let i = 0; i < 5; i++) interceptor.feed("\x0c");
    expect(shame.messages.every((m) => m === undefined)).toBe(true);
  });

  it("no escalation when messages array is empty", () => {
    const shame = new FakeShame();
    const interceptor = new HotkeyInterceptor({
      detector: makeDetector("idle"),
      overlay: new NullOverlayController(),
      shame,
      escalation: { threshold: 2, messages: [] },
    });
    for (let i = 0; i < 5; i++) interceptor.feed("\x0c");
    expect(shame.messages.every((m) => m === undefined)).toBe(true);
  });

  it("dispose cleans up the state subscription without throwing", () => {
    const detector = makeDetectorWithEvents("idle");
    const interceptor = new HotkeyInterceptor({
      detector,
      overlay: new NullOverlayController(),
      shame: new FakeShame(),
      escalation: { threshold: 2, messages: ["X"] },
    });
    expect(() => interceptor.dispose()).not.toThrow();
  });

  it("old test mocks without on() keep working (no subscription attempted)", () => {
    const shame = new FakeShame();
    // makeDetector returns a DetectorView with no on() method
    const interceptor = new HotkeyInterceptor({
      detector: makeDetector("idle"),
      overlay: new NullOverlayController(),
      shame,
      escalation: { threshold: 2, messages: ["X"] },
    });
    interceptor.feed("\x0c");
    interceptor.feed("\x0c");
    // count=2 >= threshold=2, idx=0 → "X"
    expect(shame.messages[1]).toBe("X");
  });
});
