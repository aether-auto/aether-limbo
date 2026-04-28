import { readFile as nodeReadFile } from "node:fs/promises";
import { parse } from "@iarna/toml";
import { DEFAULT_CONFIG } from "./defaults.js";
import type {
  AdaptersConfig,
  GuardConfig,
  HotkeyConfig,
  InstagramAdapterConfig,
  LimboConfig,
  SnapbackConfig,
  TikTokAdapterConfig,
  TwitterAdapterConfig,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Public error class
// ---------------------------------------------------------------------------

export class ConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigParseError";
  }
}

// ---------------------------------------------------------------------------
// Injectable interfaces
// ---------------------------------------------------------------------------

export interface Logger {
  warn(message: string): void;
}

/** Minimal fs abstraction injected into loadConfig — easier to mock in tests. */
export interface FsReader {
  readFile(path: string): Promise<Buffer | string>;
}

const noopLogger: Logger = { warn: () => undefined };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function assertString(value: unknown, path: string, source: string): string {
  if (typeof value !== "string") {
    throw new ConfigParseError(`${path} must be a string at ${source} (got ${typeof value})`);
  }
  return value;
}

function assertNumber(value: unknown, path: string, source: string): number {
  if (typeof value !== "number") {
    throw new ConfigParseError(`${path} must be a number at ${source} (got ${typeof value})`);
  }
  return value;
}

function assertBoolean(value: unknown, path: string, source: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigParseError(`${path} must be a boolean at ${source} (got ${typeof value})`);
  }
  return value;
}

function assertStringArray(value: unknown, path: string, source: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new ConfigParseError(`${path} must be an array of strings at ${source}`);
  }
  return value as string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Section parsers — each accepts unknown (raw TOML) + falls back to defaults
// ---------------------------------------------------------------------------

function parseHotkey(raw: unknown, source: string, def: HotkeyConfig): HotkeyConfig {
  if (raw === undefined) return def;
  if (!isRecord(raw)) {
    throw new ConfigParseError(`[hotkey] must be a table at ${source}`);
  }
  return {
    chord: raw.chord !== undefined ? assertString(raw.chord, "[hotkey].chord", source) : def.chord,
  };
}

function parseGuard(raw: unknown, source: string, def: GuardConfig): GuardConfig {
  if (raw === undefined) return def;
  if (!isRecord(raw)) {
    throw new ConfigParseError(`[guard] must be a table at ${source}`);
  }
  return {
    message:
      raw.message !== undefined
        ? assertString(raw.message, "[guard].message", source)
        : def.message,
    holdMs:
      raw.hold_ms !== undefined ? assertNumber(raw.hold_ms, "[guard].hold_ms", source) : def.holdMs,
    idleAttemptsBeforeEscalation:
      raw.idle_attempts_before_escalation !== undefined
        ? assertNumber(
            raw.idle_attempts_before_escalation,
            "[guard].idle_attempts_before_escalation",
            source,
          )
        : def.idleAttemptsBeforeEscalation,
    escalationMessages:
      raw.escalation_messages !== undefined
        ? assertStringArray(raw.escalation_messages, "[guard].escalation_messages", source)
        : def.escalationMessages,
  };
}

function parseSnapback(raw: unknown, source: string, def: SnapbackConfig): SnapbackConfig {
  if (raw === undefined) return def;
  if (!isRecord(raw)) {
    throw new ConfigParseError(`[snapback] must be a table at ${source}`);
  }
  return {
    enabled:
      raw.enabled !== undefined
        ? assertBoolean(raw.enabled, "[snapback].enabled", source)
        : def.enabled,
  };
}

function parseInstagram(
  raw: unknown,
  source: string,
  def: InstagramAdapterConfig,
): InstagramAdapterConfig {
  if (raw === undefined) return def;
  if (!isRecord(raw)) {
    throw new ConfigParseError(`[adapters.instagram] must be a table at ${source}`);
  }
  return {
    thumbnails:
      raw.thumbnails !== undefined
        ? assertBoolean(raw.thumbnails, "[adapters.instagram].thumbnails", source)
        : def.thumbnails,
    thumbnailMaxRows:
      raw.thumbnail_max_rows !== undefined
        ? assertNumber(raw.thumbnail_max_rows, "[adapters.instagram].thumbnail_max_rows", source)
        : def.thumbnailMaxRows,
  };
}

function parseTwitter(
  raw: unknown,
  source: string,
  def: TwitterAdapterConfig,
): TwitterAdapterConfig {
  if (raw === undefined) return def;
  if (!isRecord(raw)) {
    throw new ConfigParseError(`[adapters.twitter] must be a table at ${source}`);
  }

  let auth: TwitterAdapterConfig["auth"] = def.auth;
  if (raw.auth !== undefined) {
    const rawAuth = assertString(raw.auth, "[adapters.twitter].auth", source);
    if (rawAuth !== "twikit" && rawAuth !== "tweepy") {
      throw new ConfigParseError(
        `[adapters.twitter].auth must be "twikit" or "tweepy" at ${source} (got "${rawAuth}")`,
      );
    }
    auth = rawAuth;
  }

  return {
    auth,
    cacheDms:
      raw.cache_dms !== undefined
        ? assertBoolean(raw.cache_dms, "[adapters.twitter].cache_dms", source)
        : def.cacheDms,
    language:
      raw.language !== undefined
        ? assertString(raw.language, "[adapters.twitter].language", source)
        : def.language,
  };
}

function parseTikTok(raw: unknown, source: string, def: TikTokAdapterConfig): TikTokAdapterConfig {
  if (raw === undefined) return def;
  if (!isRecord(raw)) {
    throw new ConfigParseError(`[adapters.tiktok] must be a table at ${source}`);
  }
  return {
    refreshOnFailure:
      raw.refresh_on_failure !== undefined
        ? assertBoolean(raw.refresh_on_failure, "[adapters.tiktok].refresh_on_failure", source)
        : def.refreshOnFailure,
    keepWarm:
      raw.keep_warm !== undefined
        ? assertBoolean(raw.keep_warm, "[adapters.tiktok].keep_warm", source)
        : def.keepWarm,
  };
}

function parseAdapters(raw: unknown, source: string, def: AdaptersConfig): AdaptersConfig {
  if (raw === undefined) return def;
  if (!isRecord(raw)) {
    throw new ConfigParseError(`[adapters] must be a table at ${source}`);
  }

  let enabled: Readonly<Record<string, boolean>> = def.enabled;
  if (raw.enabled !== undefined) {
    if (!isRecord(raw.enabled)) {
      throw new ConfigParseError(`[adapters].enabled must be a table at ${source}`);
    }
    const result: Record<string, boolean> = {};
    for (const [key, val] of Object.entries(raw.enabled)) {
      result[key] = assertBoolean(val, `[adapters].enabled.${key}`, source);
    }
    enabled = result;
  }

  return {
    tabOrder:
      raw.tab_order !== undefined
        ? assertStringArray(raw.tab_order, "[adapters].tab_order", source)
        : def.tabOrder,
    enabled,
    keepWarm:
      raw.keep_warm !== undefined
        ? assertBoolean(raw.keep_warm, "[adapters].keep_warm", source)
        : def.keepWarm,
    instagram: parseInstagram(raw.instagram, source, def.instagram),
    twitter: parseTwitter(raw.twitter, source, def.twitter),
    tiktok: parseTikTok(raw.tiktok, source, def.tiktok),
  };
}

// Known top-level keys — anything else triggers a warning.
const KNOWN_KEYS = new Set(["hotkey", "guard", "snapback", "adapters"]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse TOML text into a LimboConfig.
 *
 * - Missing sections/fields fall back to DEFAULT_CONFIG values.
 * - Unrecognised top-level sections produce a non-fatal warning via `logger`.
 * - Type mismatches throw `ConfigParseError` with a descriptive field-path message.
 *
 * @param text   Raw TOML string.
 * @param source Human-readable source label used in error messages (e.g. "config.toml").
 * @param logger Injectable logger for non-fatal warnings (defaults to no-op).
 */
export function parseConfig(
  text: string,
  source = "config.toml",
  logger: Logger = noopLogger,
): LimboConfig {
  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigParseError(`Failed to parse TOML at ${source}: ${msg}`);
  }

  // Warn on unrecognised top-level keys.
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      logger.warn(`Unrecognised config section [${key}] in ${source} — ignored`);
    }
  }

  const def = DEFAULT_CONFIG;
  return {
    hotkey: parseHotkey(raw.hotkey, source, def.hotkey),
    guard: parseGuard(raw.guard, source, def.guard),
    snapback: parseSnapback(raw.snapback, source, def.snapback),
    adapters: parseAdapters(raw.adapters, source, def.adapters),
  };
}

/**
 * Load config from a TOML file on disk.
 *
 * - On ENOENT returns `{ config: DEFAULT_CONFIG, loadedFrom: null }` so callers
 *   can trigger the first-run wizard.
 * - On parse error, propagates the `ConfigParseError`.
 *
 * @param options.path   Absolute path to the config file.
 * @param options.fs     Injected fs subset (defaults to `node:fs/promises`).
 * @param options.logger Injected logger for warnings (defaults to no-op).
 */
export async function loadConfig({
  path,
  fs: fsImpl,
  logger = noopLogger,
}: {
  path: string;
  fs?: FsReader;
  logger?: Logger;
}): Promise<{ config: LimboConfig; loadedFrom: string | null }> {
  const defaultFs: FsReader = { readFile: (p: string) => nodeReadFile(p) };
  const fsRead: FsReader = fsImpl ?? defaultFs;

  let text: string;
  try {
    const buf = await fsRead.readFile(path);
    text = buf.toString();
  } catch (err) {
    if (isEnoent(err)) {
      return { config: DEFAULT_CONFIG, loadedFrom: null };
    }
    throw err;
  }

  const config = parseConfig(text, path, logger);
  return { config, loadedFrom: path };
}

// ---------------------------------------------------------------------------
// Private utilities
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
