import { type Clock, realClock } from "../detector/types.js";
import { type IShameRenderer, SHAME_HOLD_MS, SHAME_MESSAGE, type StdoutView } from "./types.js";

const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";
const CLEAR_SCREEN = "\x1b[2J";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

function moveCursor(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

export interface ShameFlashOptions {
  readonly stdout: StdoutView;
  readonly clock?: Clock;
  readonly holdMs?: number;
  readonly message?: string;
}

export class ShameFlash implements IShameRenderer {
  private active = false;
  private readonly clock: Clock;
  private readonly holdMs: number;
  private readonly message: string;

  constructor(private readonly opts: ShameFlashOptions) {
    this.clock = opts.clock ?? realClock;
    this.holdMs = opts.holdMs ?? SHAME_HOLD_MS;
    this.message = opts.message ?? SHAME_MESSAGE;
  }

  showShame(): Promise<void> {
    if (this.active) return Promise.resolve();
    this.active = true;

    const { stdout } = this.opts;
    const cols = stdout.columns ?? 80;
    const rows = stdout.rows ?? 24;
    const row = Math.max(1, Math.floor(rows / 2));
    const col = Math.max(1, Math.floor((cols - this.message.length) / 2) + 1);

    stdout.write(ALT_SCREEN_ENTER);
    stdout.write(HIDE_CURSOR);
    stdout.write(CLEAR_SCREEN);
    stdout.write(moveCursor(row, col));
    stdout.write(this.message);

    return new Promise<void>((resolve) => {
      this.clock.setTimeout(() => {
        stdout.write(SHOW_CURSOR);
        stdout.write(ALT_SCREEN_EXIT);
        this.active = false;
        resolve();
      }, this.holdMs);
    });
  }
}
