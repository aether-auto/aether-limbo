import type { StateTransition } from "../detector/types.js";
import type { IDisposable } from "../pty/types.js";
import { ChordMatcher } from "./chord-matcher.js";
import {
  type ChordFeedResult,
  DEFAULT_CHORD,
  type DetectorView,
  type HotkeyChord,
  type IHotkeyInterceptor,
  type IOverlayController,
  type IShameRenderer,
} from "./types.js";

export interface EscalationOptions {
  readonly threshold: number;
  readonly messages: readonly string[];
}

export interface HotkeyInterceptorOptions {
  readonly detector: DetectorView;
  readonly overlay: IOverlayController;
  readonly shame: IShameRenderer;
  readonly chord?: HotkeyChord;
  readonly onError?: (err: unknown) => void;
  readonly escalation?: EscalationOptions;
}

export class HotkeyInterceptor implements IHotkeyInterceptor {
  private readonly matcher: ChordMatcher;
  private idleShameCount = 0;
  private readonly stateSubscription: IDisposable | undefined;

  constructor(private readonly opts: HotkeyInterceptorOptions) {
    this.matcher = new ChordMatcher(opts.chord ?? DEFAULT_CHORD);

    // Subscribe to detector state transitions to reset counter on non-idle transitions.
    if (opts.detector.on) {
      this.stateSubscription = opts.detector.on("state", (t: StateTransition) => {
        if (t.to !== "idle") {
          this.idleShameCount = 0;
        }
      });
    }
  }

  feed(chunk: string): string {
    let result: ChordFeedResult;
    try {
      result = this.matcher.feed(chunk);
    } catch (err) {
      this.opts.onError?.(err);
      return chunk;
    }
    for (let i = 0; i < result.matched; i++) {
      this.handleChord();
    }
    return result.passthrough;
  }

  dispose(): void {
    this.stateSubscription?.dispose();
  }

  private escalationActive(): boolean {
    const { escalation } = this.opts;
    return escalation !== undefined && escalation.threshold > 0 && escalation.messages.length > 0;
  }

  private handleChord(): void {
    try {
      const { overlay, detector, shame } = this.opts;
      if (overlay.isOpen()) {
        overlay.close();
        return;
      }
      const state = detector.getState();
      if (state === "idle") {
        this.idleShameCount++;
        if (this.escalationActive()) {
          const { escalation } = this.opts;
          // escalation is defined and active; threshold/messages checked in escalationActive()
          const threshold = escalation?.threshold ?? 0;
          const messages = escalation?.messages ?? [];
          if (this.idleShameCount >= threshold) {
            const idx = (this.idleShameCount - threshold) % messages.length;
            shame.showShame(messages[idx]).catch((err) => this.opts.onError?.(err));
          } else {
            shame.showShame().catch((err) => this.opts.onError?.(err));
          }
        } else {
          shame.showShame().catch((err) => this.opts.onError?.(err));
        }
        return;
      }
      // Non-idle: open overlay and reset counter.
      this.idleShameCount = 0;
      overlay.open();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }
}
