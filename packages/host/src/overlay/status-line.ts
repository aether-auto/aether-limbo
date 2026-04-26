import type { ClaudeState } from "../detector/types.js";
import type { HotkeyChord } from "../hotkey/types.js";

const SGR_RESET = "\x1b[0m";
const SGR_DIM = "\x1b[2m";
const ESC = 0x1b;
const HEX = 16;

export interface RenderStatusLineArgs {
  readonly state: ClaudeState;
  readonly chord: HotkeyChord;
  readonly cols: number;
}

export function renderStatusLine(args: RenderStatusLineArgs): string {
  const left = `state: ${args.state}`;
  const right = `press ${describeChord(args.chord)} to return`;
  const minGap = 2;
  const totalContent = left.length + right.length;
  if (totalContent + minGap > args.cols) {
    return `${SGR_DIM}${truncate(left, args.cols)}${SGR_RESET}`;
  }
  const gap = args.cols - totalContent;
  return `${SGR_DIM}${left}${" ".repeat(gap)}${right}${SGR_RESET}`;
}

export function describeChord(chord: HotkeyChord): string {
  if (chord.length === 1) {
    const code = chord.charCodeAt(0);
    if (code === ESC) return "Esc";
    if (code === 0x09) return "Tab";
    if (code === 0x0d) return "Enter";
    if (code === 0x7f) return "Backspace";
    if (code >= 1 && code <= 26) return `Ctrl+${String.fromCharCode(0x40 + code)}`;
    if (code >= 0x20 && code <= 0x7e) return chord;
  }
  return chord
    .split("")
    .map((c) => {
      const code = c.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) return `\\x${code.toString(HEX).padStart(2, "0")}`;
      return c;
    })
    .join("");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s.padEnd(max) : s.slice(0, max);
}
