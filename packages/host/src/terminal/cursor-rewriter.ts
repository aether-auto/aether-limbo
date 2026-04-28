/**
 * Shared ANSI absolute-cursor sequence rewriter.
 *
 * Rewrites CUP/HVP/VPA/bare-CUP/CSI-2J so that origin (1,1) maps to
 * (top, left) in absolute screen coordinates. This is the same pattern
 * used by CarbonylSubpane.relayChunk — extracted here so OverlayPane
 * can reuse it for thumbnail painting without duplicating the regex.
 */

// Matches: CSI <r>;<c> H|f  (CUP / HVP), CSI <r> d (VPA), bare CSI H, CSI 2J
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI ESC introducer is the whole point
const CSI_ABSOLUTE_RE = /\x1b\[(\d*);(\d*)([Hf])|\x1b\[(\d+)d|\x1b\[H|\x1b\[2J/g;

export interface RewriteResult {
  readonly rewritten: string;
  readonly hasAbsoluteStart: boolean;
}

/**
 * Rewrite absolute-cursor sequences in `chunk` so that logical (1,1) maps
 * to screen (top, left). CSI 2J is replaced with blanked rows in the rect.
 */
export function rewriteAbsoluteCursors(
  chunk: string,
  top: number,
  left: number,
  cols: number,
  rows: number,
): RewriteResult {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI ESC introducer is the whole point
  const hasAbsoluteStart = /^\x1b\[(\d*;?\d*)[Hf]/.test(chunk);

  let blankRows = "";
  for (let i = 0; i < rows; i++) {
    blankRows += `\x1b[${top + i};${left}H${" ".repeat(cols)}`;
  }

  const rewritten = chunk.replace(CSI_ABSOLUTE_RE, (match, r1, c1, cupFlag, vpaRow) => {
    if (match === "\x1b[2J") {
      return blankRows;
    }
    if (match === "\x1b[H") {
      return `\x1b[${top};${left}H`;
    }
    if (vpaRow !== undefined) {
      const r = Number.parseInt(vpaRow, 10);
      return `\x1b[${r + top - 1}d`;
    }
    // CUP / HVP
    const r = r1 !== "" ? Number.parseInt(r1, 10) : 1;
    const c = c1 !== "" ? Number.parseInt(c1, 10) : 1;
    return `\x1b[${r + top - 1};${c + left - 1}${cupFlag}`;
  });

  return { rewritten, hasAbsoluteStart };
}
