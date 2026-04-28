import type { ClaudeState, StateTransition } from "../detector/types.js";
import type { IDisposable } from "../pty/types.js";

export type HotkeyChord = string;

export const DEFAULT_CHORD: HotkeyChord = "\x0c";

export const SHAME_MESSAGE = "be productive, dumbass.";
export const SHAME_HOLD_MS = 1200;

export interface IOverlayController {
  isOpen(): boolean;
  open(): void;
  close(): void;
  handleInput(chunk: string): void;
  handleResize(cols: number, rows: number): void;
}

export interface IShameRenderer {
  showShame(message?: string): Promise<void>;
}

export interface DetectorView {
  getState(): ClaudeState;
  on?(event: "state", listener: (transition: StateTransition) => void): IDisposable;
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
