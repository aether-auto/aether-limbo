import type { ClaudeState } from "../detector/types.js";

export type HotkeyChord = string;

export const DEFAULT_CHORD: HotkeyChord = "\x0c";

export const SHAME_MESSAGE = "be productive, dumbass.";
export const SHAME_HOLD_MS = 1200;

export interface IOverlayController {
  isOpen(): boolean;
  open(): void;
  close(): void;
}

export interface IShameRenderer {
  showShame(): Promise<void>;
}

export interface DetectorView {
  getState(): ClaudeState;
}

export interface StdoutView {
  readonly columns?: number;
  readonly rows?: number;
  write(chunk: string): boolean;
}

export interface ChordFeedResult {
  readonly passthrough: string;
  readonly matched: number;
}

export interface IHotkeyInterceptor {
  feed(chunk: string): string;
}
