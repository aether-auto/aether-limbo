import type { IDisposable } from "../pty/types.js";

export type ClaudeState = "idle" | "thinking" | "streaming" | "tool_running";

export interface StateTransition {
  readonly from: ClaudeState;
  readonly to: ClaudeState;
  readonly atMs: number;
}

export type StateListener = (transition: StateTransition) => void;

export interface IClaudeDetector {
  feed(chunk: string): void;
  getState(): ClaudeState;
  on(event: "state", listener: StateListener): IDisposable;
  dispose(): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(handle: NodeJS.Timeout): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};
