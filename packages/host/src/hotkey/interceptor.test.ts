import { describe, expect, it, vi } from "vitest";
import type { ClaudeState } from "../detector/types.js";
import { HotkeyInterceptor } from "./interceptor.js";
import { NullOverlayController } from "./overlay-stub.js";
import type { DetectorView, IShameRenderer } from "./types.js";

function makeDetector(state: ClaudeState): DetectorView {
  return { getState: () => state };
}

class FakeShame implements IShameRenderer {
  calls = 0;
  showShame(): Promise<void> {
    this.calls++;
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
