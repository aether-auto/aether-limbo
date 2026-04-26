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

export interface HotkeyInterceptorOptions {
  readonly detector: DetectorView;
  readonly overlay: IOverlayController;
  readonly shame: IShameRenderer;
  readonly chord?: HotkeyChord;
  readonly onError?: (err: unknown) => void;
}

export class HotkeyInterceptor implements IHotkeyInterceptor {
  private readonly matcher: ChordMatcher;

  constructor(private readonly opts: HotkeyInterceptorOptions) {
    this.matcher = new ChordMatcher(opts.chord ?? DEFAULT_CHORD);
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

  private handleChord(): void {
    try {
      const { overlay, detector, shame } = this.opts;
      if (overlay.isOpen()) {
        overlay.close();
        return;
      }
      const state = detector.getState();
      if (state === "idle") {
        shame.showShame().catch((err) => this.opts.onError?.(err));
        return;
      }
      overlay.open();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }
}
