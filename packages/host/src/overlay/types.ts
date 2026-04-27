import type { IAdapterRegistry } from "../adapters/types.js";
import type { IClaudeDetector } from "../detector/types.js";
import type { HotkeyChord, StdoutView } from "../hotkey/types.js";

export type TabId = "reels" | "feed" | "dms" | "x" | "tiktok" | "__echo";

export interface TabDefinition {
  readonly id: TabId;
  readonly label: string;
  readonly placeholderRef: string;
  readonly adapterId?: string;
}

export const DEFAULT_TABS: readonly TabDefinition[] = [
  { id: "reels", label: "Reels", placeholderRef: "§4.7", adapterId: "instagram-reels" },
  { id: "feed", label: "Feed", placeholderRef: "§4.7", adapterId: "instagram-feed" },
  { id: "dms", label: "DMs", placeholderRef: "§4.7", adapterId: "instagram-dms" },
  { id: "x", label: "X", placeholderRef: "§4.8" },
  { id: "tiktok", label: "TikTok", placeholderRef: "§4.9" },
];

export type KeyAction =
  | { kind: "close" }
  | { kind: "tab-prev" }
  | { kind: "tab-next" }
  | { kind: "tab-jump"; index: number }
  | { kind: "scroll-up" }
  | { kind: "scroll-down" }
  | { kind: "scroll-top" }
  | { kind: "scroll-bottom" }
  | { kind: "enter" };

export interface KeymapResult {
  readonly actions: readonly KeyAction[];
}

export interface OverlayDeps {
  readonly stdout: StdoutView;
  readonly detector: IClaudeDetector;
  readonly chord?: HotkeyChord;
  readonly tabs?: readonly TabDefinition[];
  readonly registry?: IAdapterRegistry;
}
