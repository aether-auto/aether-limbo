/**
 * Pure TypeScript types for the aether-limbo configuration schema.
 * No logic — only type definitions.
 */

export interface LimboConfig {
  readonly hotkey: HotkeyConfig;
  readonly guard: GuardConfig;
  readonly snapback: SnapbackConfig;
  readonly adapters: AdaptersConfig;
}

export interface HotkeyConfig {
  /** Already-decoded byte string for the activation chord. */
  readonly chord: string;
}

export interface GuardConfig {
  /** Shame banner text displayed when the hotkey is pressed. */
  readonly message: string;
  /** Duration (ms) the shame banner is held on screen. */
  readonly holdMs: number;
  /** Number of idle attempts before showing escalation copy. 0 = disabled. */
  readonly idleAttemptsBeforeEscalation: number;
  /** Round-robin source of escalation messages. */
  readonly escalationMessages: readonly string[];
}

export interface SnapbackConfig {
  /** Whether to auto-snap back to Claude on response completion. */
  readonly enabled: boolean;
}

export interface AdaptersConfig {
  /** Tab IDs in display order. */
  readonly tabOrder: readonly string[];
  /** Per-tab enabled flag, keyed by tab id. */
  readonly enabled: Readonly<Record<string, boolean>>;
  /** Keep sidecar processes warm across overlay close/open. */
  readonly keepWarm: boolean;
  readonly instagram: InstagramAdapterConfig;
  readonly twitter: TwitterAdapterConfig;
  readonly tiktok: TikTokAdapterConfig;
}

export interface InstagramAdapterConfig {
  /** Render sixel/kitty thumbnails in Feed view. */
  readonly thumbnails: boolean;
  /** Maximum rows used to render a thumbnail. */
  readonly thumbnailMaxRows: number;
}

export interface TwitterAdapterConfig {
  /** Authentication backend: cookie-based twikit or API-key tweepy. */
  readonly auth: "twikit" | "tweepy";
  /** Cache DM availability at session level to skip redundant probes. */
  readonly cacheDms: boolean;
  /** BCP-47 language tag for timeline language filter. */
  readonly language: string;
}

export interface TikTokAdapterConfig {
  /** Attempt a transparent session refresh once before surfacing the token form. */
  readonly refreshOnFailure: boolean;
  /** Keep Playwright context warm across sidecar respawn. */
  readonly keepWarm: boolean;
}
