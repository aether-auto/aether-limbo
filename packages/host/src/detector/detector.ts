import { EventEmitter } from "node:events";
import type { IDisposable } from "../pty/types.js";
import { analyseChunk } from "./heuristics.js";
import {
  type ClaudeState,
  type Clock,
  type IClaudeDetector,
  type StateListener,
  type StateTransition,
  realClock,
} from "./types.js";

export const DEFAULT_DEBOUNCE_MS = 150;
export const FRAME_WINDOW_MS = 1000;
export const FRAME_CYCLE_THRESHOLD = 2;

export interface DetectorOptions {
  readonly debounceMs?: number;
  readonly clock?: Clock;
  readonly frameWindowMs?: number;
  readonly frameCycleThreshold?: number;
}

interface ObservedFrame {
  readonly glyph: string;
  readonly atMs: number;
}

export class ClaudeStateDetector implements IClaudeDetector {
  private state: ClaudeState = "idle";
  private readonly emitter = new EventEmitter();
  private readonly clock: Clock;
  private readonly debounceMs: number;
  private readonly frameWindowMs: number;
  private readonly frameCycleThreshold: number;
  private idleTimer: NodeJS.Timeout | undefined;
  private recentFrames: ObservedFrame[] = [];
  private disposed = false;

  constructor(opts: DetectorOptions = {}) {
    this.clock = opts.clock ?? realClock;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.frameWindowMs = opts.frameWindowMs ?? FRAME_WINDOW_MS;
    this.frameCycleThreshold = opts.frameCycleThreshold ?? FRAME_CYCLE_THRESHOLD;
  }

  feed(chunk: string): void {
    if (this.disposed || chunk.length === 0) return;
    const ev = analyseChunk(chunk);
    const now = this.clock.now();

    if (ev.spinnerGlyphs.length > 0) {
      for (const g of ev.spinnerGlyphs) this.recentFrames.push({ glyph: g, atMs: now });
    }
    this.recentFrames = this.recentFrames.filter((f) => now - f.atMs <= this.frameWindowMs);
    // Cycling is positive evidence only when the *current* chunk also contains
    // a spinner glyph. Without this guard, recently-buffered frames would keep
    // classifying subsequent prose chunks as "thinking" long after the spinner
    // stopped — tripping the replay test scenario-1 chunk@300ms.
    const cycling =
      ev.spinnerGlyphs.length > 0 &&
      new Set(this.recentFrames.map((f) => f.glyph)).size >= this.frameCycleThreshold;
    const spinnerActive = (ev.hasSpinnerContext && ev.spinnerGlyphs.length > 0) || cycling;

    let next: ClaudeState | undefined;
    if (ev.hasToolMarker) next = "tool_running";
    else if (spinnerActive) next = "thinking";
    else if (ev.hasStreamingText || ev.hasPromptSigil) next = "streaming";

    if (next !== undefined && next !== this.state) {
      this.transition(next);
    }
    this.armIdleTimer(ev.hasPromptSigil);
  }

  private armIdleTimer(promptVisible: boolean): void {
    if (this.idleTimer !== undefined) {
      this.clock.clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.state === "idle") return;
    const delay = promptVisible ? this.debounceMs : this.debounceMs * 4;
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = undefined;
      if (!this.disposed && this.state !== "idle") this.transition("idle");
    }, delay);
  }

  private transition(to: ClaudeState): void {
    const t: StateTransition = { from: this.state, to, atMs: this.clock.now() };
    this.state = to;
    this.emitter.emit("state", t);
  }

  getState(): ClaudeState {
    return this.state;
  }

  on(event: "state", listener: StateListener): IDisposable {
    this.emitter.on(event, listener);
    return {
      dispose: () => this.emitter.off(event, listener),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer !== undefined) {
      this.clock.clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.recentFrames = [];
    this.emitter.removeAllListeners();
  }
}
