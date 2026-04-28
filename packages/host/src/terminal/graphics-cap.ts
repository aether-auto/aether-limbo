/**
 * Terminal graphics capability detection for chafa thumbnail rendering.
 *
 * Detection heuristics (in priority order):
 *   1. LIMBO_GRAPHICS_PROTOCOL env var — explicit override: "kitty" | "sixel" | "symbols" | "none"
 *      "none" is treated as a disable signal; callers should check the override separately.
 *   2. KITTY_WINDOW_ID present → "kitty"
 *   3. TERM matches /xterm-kitty|kitty/ → "kitty"
 *   4. TERM_PROGRAM is "iTerm.app" or "WezTerm" → "sixel" (both support sixel natively)
 *   5. TERM matches /xterm-256color|screen-256color|tmux-256color/ → "symbols" (safe ASCII art)
 *   6. Otherwise → "symbols" (chafa always supports symbols; universal fallback)
 *
 * The "none" override disables thumbnail rendering entirely. Host code checks
 * `LIMBO_GRAPHICS_PROTOCOL === "none"` directly to skip the thumbnail flow.
 */

export type GraphicsProtocol = "kitty" | "sixel" | "symbols";

export interface DetectGraphicsProtocolOpts {
  /** When false, skip TTY-specific heuristics (unused for now, reserved). */
  readonly tty?: boolean;
}

/**
 * Detect the best graphics protocol supported by the current terminal.
 * Returns "symbols" for the "none" override so callers receive a valid
 * GraphicsProtocol; the caller is responsible for also checking
 * `env.LIMBO_GRAPHICS_PROTOCOL === "none"` to gate the thumbnail flow.
 */
export function detectGraphicsProtocol(
  env: NodeJS.ProcessEnv,
  _opts?: DetectGraphicsProtocolOpts,
): GraphicsProtocol {
  const override = env.LIMBO_GRAPHICS_PROTOCOL;
  if (override !== undefined) {
    if (override === "kitty") return "kitty";
    if (override === "sixel") return "sixel";
    // "none" or "symbols" both map to symbols; host gates on "none" separately.
    return "symbols";
  }

  // Kitty window ID is set by kitty itself — most reliable signal.
  if (env.KITTY_WINDOW_ID !== undefined) return "kitty";

  // TERM-based kitty detection (remote sessions, nested tmux inside kitty, etc.)
  const term = env.TERM ?? "";
  if (/xterm-kitty|kitty/.test(term)) return "kitty";

  // iTerm2 and WezTerm both support sixel.
  const termProgram = env.TERM_PROGRAM ?? "";
  if (termProgram === "iTerm.app" || termProgram === "WezTerm") return "sixel";

  // Common 256-colour terms: use symbols (safe, no binary protocol needed).
  if (/xterm-256color|screen-256color|tmux-256color/.test(term)) return "symbols";

  // Unknown terminal — symbols is the safest fallback.
  return "symbols";
}

/**
 * Returns true when thumbnails should be completely disabled.
 * This is the case when LIMBO_GRAPHICS_PROTOCOL is explicitly set to "none"
 * OR when LIMBO_IG_THUMBNAILS is "0".
 */
export function thumbnailsDisabled(env: NodeJS.ProcessEnv): boolean {
  if (env.LIMBO_GRAPHICS_PROTOCOL === "none") return true;
  if (env.LIMBO_IG_THUMBNAILS === "0") return true;
  return false;
}

/**
 * Parse LIMBO_IG_THUMBNAIL_MAX_ROWS from env.
 * Returns 0 when thumbnails are disabled; defaults to 6.
 */
export function thumbnailMaxRows(env: NodeJS.ProcessEnv): number {
  if (thumbnailsDisabled(env)) return 0;
  const raw = env.LIMBO_IG_THUMBNAIL_MAX_ROWS;
  if (raw === undefined) return 6;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 6;
}
