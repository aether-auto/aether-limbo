import type { IDisposable, IPty, PtyExit, PtyFactory } from "../pty/types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CarbonylSubpaneStdout {
  write(chunk: string): boolean;
}

export interface CarbonylSubpaneOptions {
  readonly stdout: CarbonylSubpaneStdout;
  readonly ptyFactory: PtyFactory;
  readonly carbonylBin: string;
  readonly url: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  // Sub-rect (1-indexed to match VT100 convention)
  readonly top: number;
  readonly left: number;
  readonly cols: number;
  readonly rows: number;
}

// ---------------------------------------------------------------------------
// ANSI rewriter helpers
// ---------------------------------------------------------------------------

// Matches: CSI <r>;<c> H|f  (CUP / HVP), CSI <r> d (VPA), bare CSI H, CSI 2J
// We process the string character by character via regex replace.
const CSI_ABSOLUTE_RE =
  /\x1b\[(\d*);(\d*)([Hf])|\x1b\[(\d+)d|\x1b\[H|\x1b\[2J/g;

function rewriteChunk(
  chunk: string,
  top: number,
  left: number,
  cols: number,
  rows: number,
): { rewritten: string; hasAbsoluteStart: boolean } {
  let hasAbsoluteStart = false;
  let firstMatch = true;

  // We need to track whether the very first visible sequence is absolute.
  // Scan from start to see if there's a CUP/HVP/bare-H before any non-CSI text.
  const startsWithAbsolute = /^\x1b\[(\d*;?\d*)[Hf]/.test(chunk);
  if (startsWithAbsolute) hasAbsoluteStart = true;

  // Blank rows replacement buffer for 2J
  let blankRows = "";
  for (let i = 0; i < rows; i++) {
    blankRows += `\x1b[${top + i};${left}H` + " ".repeat(cols);
  }

  const rewritten = chunk.replace(CSI_ABSOLUTE_RE, (match, r1, c1, cupFlag, vpaRow) => {
    if (firstMatch) {
      firstMatch = false;
    }

    // CSI 2J → drop it, emit blank rows inline
    if (match === "\x1b[2J") {
      return blankRows;
    }

    // Bare CSI H → treat as CSI 1;1 H
    if (match === "\x1b[H") {
      return `\x1b[${top};${left}H`;
    }

    // CSI <r> d (VPA)
    if (vpaRow !== undefined) {
      const r = parseInt(vpaRow, 10);
      return `\x1b[${r + top - 1}d`;
    }

    // CSI <r>;<c> H|f (CUP / HVP)
    const r = r1 !== "" ? parseInt(r1, 10) : 1;
    const c = c1 !== "" ? parseInt(c1, 10) : 1;
    return `\x1b[${r + top - 1};${c + left - 1}${cupFlag}`;
  });

  return { rewritten, hasAbsoluteStart };
}

// ---------------------------------------------------------------------------
// CarbonylSubpane
// ---------------------------------------------------------------------------

export class CarbonylSubpane {
  private readonly stdout: CarbonylSubpaneStdout;
  private readonly pty: IPty;
  private top: number;
  private left: number;
  private cols: number;
  private rows: number;
  private exitHandlers: Array<(event: PtyExit) => void> = [];

  constructor(opts: CarbonylSubpaneOptions) {
    this.stdout = opts.stdout;
    this.top = opts.top;
    this.left = opts.left;
    this.cols = opts.cols;
    this.rows = opts.rows;

    this.pty = opts.ptyFactory({
      file: opts.carbonylBin,
      args: [opts.url],
      env: opts.env,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
    });

    this.pty.onData((chunk) => {
      this.relayChunk(chunk);
    });

    this.pty.onExit((event) => {
      for (const h of this.exitHandlers) h(event);
    });
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private relayChunk(chunk: string): void {
    const { rewritten, hasAbsoluteStart } = rewriteChunk(
      chunk,
      this.top,
      this.left,
      this.cols,
      this.rows,
    );

    // Bracket with cursor save/restore.
    // If the rewritten chunk doesn't begin with an absolute CUP/HVP, prepend
    // an initial position so relative cursor output lands inside the sub-rect.
    const initialPos = hasAbsoluteStart ? "" : `\x1b[${this.top};${this.left}H`;
    const payload = `\x1b[s${initialPos}${rewritten}\x1b[u`;
    this.stdout.write(payload);
  }

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  resize(cols: number, rows: number, top?: number, left?: number): void {
    this.cols = cols;
    this.rows = rows;
    if (top !== undefined) this.top = top;
    if (left !== undefined) this.left = left;
    this.pty.resize(cols, rows);
  }

  kill(): void {
    // Clear the sub-rect
    let clearSeq = "\x1b[s";
    for (let i = 0; i < this.rows; i++) {
      clearSeq += `\x1b[${this.top + i};${this.left}H` + " ".repeat(this.cols);
    }
    clearSeq += "\x1b[u";
    this.stdout.write(clearSeq);

    this.pty.kill("SIGTERM");
  }

  onExit(handler: (event: PtyExit) => void): IDisposable {
    this.exitHandlers.push(handler);
    return {
      dispose: () => {
        this.exitHandlers = this.exitHandlers.filter((h) => h !== handler);
      },
    };
  }
}
