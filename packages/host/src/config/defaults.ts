import type { LimboConfig } from "./schema.js";

/**
 * Default configuration matching today's hard-coded behaviour exactly.
 *
 * - hotkey.chord: Ctrl+L (\x0c) — matches DEFAULT_CHORD in hotkey/types.ts
 * - guard.message / holdMs: matches SHAME_MESSAGE / SHAME_HOLD_MS
 * - adapters.tabOrder: matches DEFAULT_TABS order in overlay/types.ts
 */
export const DEFAULT_CONFIG: LimboConfig = {
  hotkey: {
    chord: "\x0c",
  },
  guard: {
    message: "be productive, dumbass.",
    holdMs: 1200,
    idleAttemptsBeforeEscalation: 0,
    escalationMessages: [],
  },
  snapback: {
    enabled: true,
  },
  adapters: {
    tabOrder: ["reels", "feed", "dms", "x", "tiktok"],
    enabled: {
      reels: true,
      feed: true,
      dms: true,
      x: true,
      tiktok: true,
    },
    keepWarm: false,
    instagram: {
      thumbnails: true,
      thumbnailMaxRows: 6,
    },
    twitter: {
      auth: "twikit",
      cacheDms: false,
      language: "en-US",
    },
    tiktok: {
      refreshOnFailure: false,
      keepWarm: false,
    },
  },
} as const;
