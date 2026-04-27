import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { IAdapter, IAdapterRegistry, IPane } from "../adapters/types.js";
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

class RecordingAdapter implements IAdapter {
  readonly id = "rec";
  mountCalls = 0;
  unmountCalls = 0;
  keys: string[] = [];
  pane: IPane | undefined;
  async mount(pane: IPane): Promise<void> {
    this.mountCalls++;
    this.pane = pane;
  }
  async unmount(): Promise<void> {
    this.unmountCalls++;
  }
  handleKey(a: { kind: string }): void {
    this.keys.push(a.kind);
  }
}

function registryWith(adapter: IAdapter): IAdapterRegistry {
  return {
    get: (id: string) => (id === "rec" ? adapter : undefined),
    list: () => [],
  };
}

describe("LimboOverlay adapter integration", () => {
  it("mounts the active tab's adapter on open()", async () => {
    const detector = new FakeDetector();
    const stdout = makeStdout();
    const adapter = new RecordingAdapter();
    const overlay = new LimboOverlay({
      stdout,
      detector,
      registry: registryWith(adapter),
      tabs: [{ id: "__echo", label: "Echo", placeholderRef: "§4.6", adapterId: "rec" }],
    });
    overlay.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(adapter.mountCalls).toBe(1);
  });

  it("unmounts the previous adapter when the active tab changes", async () => {
    const detector = new FakeDetector();
    const stdout = makeStdout();
    const a1 = new RecordingAdapter();
    const a2 = new RecordingAdapter();
    let returnSecond = false;
    const registry: IAdapterRegistry = {
      get: () => (returnSecond ? a2 : a1),
      list: () => [],
    };
    const overlay = new LimboOverlay({
      stdout,
      detector,
      registry,
      tabs: [
        { id: "__echo", label: "Echo", placeholderRef: "§4.6", adapterId: "rec" },
        { id: "feed", label: "Feed", placeholderRef: "§4.6", adapterId: "rec" },
      ],
    });
    overlay.open();
    await Promise.resolve();
    returnSecond = true;
    overlay.handleInput("l");
    await Promise.resolve();
    await Promise.resolve();
    expect(a1.unmountCalls).toBe(1);
    expect(a2.mountCalls).toBe(1);
  });

  it("forwards scroll-* actions to the active adapter", async () => {
    const detector = new FakeDetector();
    const stdout = makeStdout();
    const adapter = new RecordingAdapter();
    const overlay = new LimboOverlay({
      stdout,
      detector,
      registry: registryWith(adapter),
      tabs: [{ id: "__echo", label: "Echo", placeholderRef: "§4.6", adapterId: "rec" }],
    });
    overlay.open();
    await Promise.resolve();
    overlay.handleInput("j");
    overlay.handleInput("k");
    expect(adapter.keys).toEqual(["scroll-down", "scroll-up"]);
  });

  it("force-unmounts the active adapter on close()", async () => {
    const detector = new FakeDetector();
    const stdout = makeStdout();
    const adapter = new RecordingAdapter();
    const overlay = new LimboOverlay({
      stdout,
      detector,
      registry: registryWith(adapter),
      tabs: [{ id: "__echo", label: "Echo", placeholderRef: "§4.6", adapterId: "rec" }],
    });
    overlay.open();
    await Promise.resolve();
    overlay.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(adapter.unmountCalls).toBe(1);
  });

  it("tabs without an adapterId fall back to the static placeholder body", () => {
    const detector = new FakeDetector();
    const stdout = makeStdout();
    const overlay = new LimboOverlay({ stdout, detector });
    overlay.open();
    expect(stdout.buffer.join("")).toContain("adapter not yet implemented");
  });

  it("force-unmounts an adapter whose mount() resolves AFTER close() runs (open/close race)", async () => {
    // SlowAdapter pauses inside mount() on an external resume signal so we can
    // call close() between mount-entry and mount-completion.
    class SlowAdapter implements IAdapter {
      readonly id = "rec";
      mountCalls = 0;
      unmountCalls = 0;
      readonly entered: Promise<void>;
      private signalEntered: () => void = () => undefined;
      readonly resume: Promise<void>;
      private signalResume: () => void = () => undefined;
      constructor() {
        this.entered = new Promise<void>((r) => {
          this.signalEntered = r;
        });
        this.resume = new Promise<void>((r) => {
          this.signalResume = r;
        });
      }
      async mount(_pane: IPane): Promise<void> {
        this.mountCalls++;
        this.signalEntered();
        await this.resume;
      }
      async unmount(): Promise<void> {
        this.unmountCalls++;
      }
      handleKey(): void {
        /* unused */
      }
      release(): void {
        this.signalResume();
      }
    }

    const detector = new FakeDetector();
    const stdout = makeStdout();
    const adapter = new SlowAdapter();
    const overlay = new LimboOverlay({
      stdout,
      detector,
      registry: registryWith(adapter),
      tabs: [{ id: "__echo", label: "Echo", placeholderRef: "§4.6", adapterId: "rec" }],
    });
    overlay.open();
    await adapter.entered; // mount has run up to its await
    overlay.close(); // close runs while mount is suspended
    adapter.release(); // mount completes
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(adapter.mountCalls).toBe(1);
    expect(adapter.unmountCalls).toBe(1);
  });
});

describe("LimboOverlay enter routing", () => {
  it("routes Enter keypress to mounted adapter.onEnter", async () => {
    const onEnter = vi.fn();
    const fake: IAdapter = {
      id: "ig",
      mount: async () => undefined,
      unmount: async () => undefined,
      handleKey: () => undefined,
      onEnter,
    };
    const registry: IAdapterRegistry = { get: () => fake, list: () => [] };
    const stdout = makeStdout();
    const detector = new FakeDetector();
    const overlay = new LimboOverlay({
      stdout,
      detector,
      registry,
      tabs: [{ id: "reels", label: "Reels", placeholderRef: "§4.7", adapterId: "ig" }],
    });
    overlay.open();
    await Promise.resolve();
    overlay.handleInput("\r");
    expect(onEnter).toHaveBeenCalledOnce();
    expect(overlay.isOpen()).toBe(true); // Enter does NOT close the overlay
  });

  it("Enter on adapter without onEnter does nothing (no throw, overlay stays open)", async () => {
    const fake: IAdapter = {
      id: "ig",
      mount: async () => undefined,
      unmount: async () => undefined,
      handleKey: () => undefined,
    };
    const registry: IAdapterRegistry = { get: () => fake, list: () => [] };
    const stdout = makeStdout();
    const detector = new FakeDetector();
    const overlay = new LimboOverlay({
      stdout,
      detector,
      registry,
      tabs: [{ id: "reels", label: "Reels", placeholderRef: "§4.7", adapterId: "ig" }],
    });
    overlay.open();
    await Promise.resolve();
    expect(() => overlay.handleInput("\r")).not.toThrow();
    expect(overlay.isOpen()).toBe(true);
  });
});

describe("LimboOverlay captureInput seam", () => {
  it("routes raw input to adapter.captureInput before the keymap (chunk consumed, overlay stays open)", async () => {
    const detector = new FakeDetector();
    const stdout = makeStdout();
    let captured: string | undefined;
    const capturingAdapter: IAdapter = {
      id: "rec",
      async mount(_pane: IPane): Promise<void> {},
      async unmount(): Promise<void> {},
      handleKey(): void {},
      captureInput(chunk: string): boolean {
        captured = chunk;
        return true; // consume — keymap must NOT see this
      },
    };
    const overlay = new LimboOverlay({
      stdout,
      detector,
      registry: { get: () => capturingAdapter, list: () => [] },
      tabs: [{ id: "__echo", label: "Echo", placeholderRef: "§4.7", adapterId: "rec" }],
    });
    overlay.open();
    await Promise.resolve();
    await Promise.resolve();
    overlay.handleInput("q"); // 'q' would normally close via keymap
    expect(captured).toBe("q");
    expect(overlay.isOpen()).toBe(true); // keymap was bypassed
  });

  it("falls back to keymap when captureInput returns false (q must close)", async () => {
    const detector = new FakeDetector();
    const stdout = makeStdout();
    const passthroughAdapter: IAdapter = {
      id: "rec",
      async mount(_pane: IPane): Promise<void> {},
      async unmount(): Promise<void> {},
      handleKey(): void {},
      captureInput(_chunk: string): boolean {
        return false; // do NOT consume — let keymap handle it
      },
    };
    const overlay = new LimboOverlay({
      stdout,
      detector,
      registry: { get: () => passthroughAdapter, list: () => [] },
      tabs: [{ id: "__echo", label: "Echo", placeholderRef: "§4.7", adapterId: "rec" }],
    });
    overlay.open();
    await Promise.resolve();
    await Promise.resolve();
    overlay.handleInput("q");
    expect(overlay.isOpen()).toBe(false); // keymap closed it
  });

  it("adapters without captureInput keep current behavior (q must close)", async () => {
    const detector = new FakeDetector();
    const stdout = makeStdout();
    // Deliberately no captureInput field
    const plainAdapter: IAdapter = {
      id: "rec",
      async mount(_pane: IPane): Promise<void> {},
      async unmount(): Promise<void> {},
      handleKey(): void {},
    };
    const overlay = new LimboOverlay({
      stdout,
      detector,
      registry: { get: () => plainAdapter, list: () => [] },
      tabs: [{ id: "__echo", label: "Echo", placeholderRef: "§4.7", adapterId: "rec" }],
    });
    overlay.open();
    await Promise.resolve();
    await Promise.resolve();
    overlay.handleInput("q");
    expect(overlay.isOpen()).toBe(false); // keymap closed it as normal
  });
});
