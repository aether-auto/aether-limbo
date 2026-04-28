import type { IDisposable } from "../pty/types.js";
import { rewriteAbsoluteCursors } from "../terminal/cursor-rewriter.js";
import type { IPane, ThumbnailRect } from "./types.js";

interface StdoutLike {
  readonly columns?: number;
  readonly rows?: number;
  write(chunk: string): boolean;
}

const SGR_RESET = "\x1b[0m";

export interface OverlayPaneOptions {
  readonly stdout: StdoutLike;
  readonly topRow: number;
  readonly bottomRow: number;
}

export class OverlayPane implements IPane {
  private topRow_: number;
  private bottomRow_: number;
  private cols_: number | undefined;
  private readonly resizeListeners: Array<(c: number, r: number) => void> = [];

  constructor(private readonly opts: OverlayPaneOptions) {
    this.topRow_ = opts.topRow;
    this.bottomRow_ = opts.bottomRow;
  }

  get cols(): number {
    return this.cols_ ?? this.opts.stdout.columns ?? 80;
  }

  get rows(): number {
    return Math.max(0, this.bottomRow_ - this.topRow_);
  }

  get topRow(): number {
    return this.topRow_;
  }

  setLines(lines: readonly string[]): void {
    const { stdout } = this.opts;
    const w = this.cols;
    for (let i = 0; i < this.rows; i++) {
      const target = this.topRow_ + i;
      stdout.write(`\x1b[${target};1H`);
      const raw = lines[i] ?? "";
      const line = raw.length > w ? raw.slice(0, w) : raw.padEnd(w);
      stdout.write(line);
    }
    stdout.write(SGR_RESET);
  }

  writeRaw(bytes: Uint8Array, rect: ThumbnailRect): void {
    const { stdout } = this.opts;
    const paneRows = this.rows;
    const paneCols = this.cols;

    // Validate rect bounds — drop silently if out of range.
    if (
      rect.topRow < 1 ||
      rect.leftCol < 1 ||
      rect.topRow > paneRows ||
      rect.leftCol > paneCols ||
      rect.rows <= 0 ||
      rect.cols <= 0
    ) {
      return;
    }

    // Convert pane-relative rect to absolute screen coordinates.
    const absTop = this.topRow_ + rect.topRow - 1;
    const absLeft = rect.leftCol;

    // Decode bytes to string (chafa output is always valid UTF-8 / ASCII).
    const chunk = new TextDecoder().decode(bytes);

    const { rewritten, hasAbsoluteStart } = rewriteAbsoluteCursors(
      chunk,
      absTop,
      absLeft,
      rect.cols,
      rect.rows,
    );

    // Bracket with cursor save/restore; prepend initial position if needed.
    const initialPos = hasAbsoluteStart ? "" : `\x1b[${absTop};${absLeft}H`;
    stdout.write(`\x1b[s${initialPos}${rewritten}\x1b[u`);
  }

  on(event: "resize", listener: (cols: number, rows: number) => void): IDisposable {
    if (event !== "resize") throw new Error(`OverlayPane: unknown event ${event}`);
    this.resizeListeners.push(listener);
    return {
      dispose: () => {
        const i = this.resizeListeners.indexOf(listener);
        if (i >= 0) this.resizeListeners.splice(i, 1);
      },
    };
  }

  handleResize(cols: number, _rows: number, rect: { topRow: number; bottomRow: number }): void {
    this.cols_ = cols;
    this.topRow_ = rect.topRow;
    this.bottomRow_ = rect.bottomRow;
    for (const l of this.resizeListeners) l(this.cols, this.rows);
  }
}
