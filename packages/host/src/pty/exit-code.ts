import type { PtyExit } from "./types.js";

const MAX_EXIT_CODE = 255;
const SIGNAL_OFFSET = 128;

export function translateExit(event: PtyExit): number {
  const sig = event.signal;
  if (sig !== undefined && sig > 0) {
    return Math.min(SIGNAL_OFFSET + sig, MAX_EXIT_CODE);
  }
  return event.exitCode;
}
