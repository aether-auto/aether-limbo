import {
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  rename as nodeRename,
  stat as nodeStat,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { stringify } from "@iarna/toml";
import type { JsonMap } from "@iarna/toml";
import { parse } from "@iarna/toml";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LimboSecrets {
  readonly instagram: { username?: string; password?: string };
  readonly twitter: {
    username?: string; // twikit re-login
    password?: string; // twikit re-login
    bearerToken?: string;
    apiKey?: string;
    apiSecret?: string;
    accessToken?: string;
    accessSecret?: string;
  };
  readonly tiktok: { msToken?: string };
}

export const EMPTY_SECRETS: LimboSecrets = {
  instagram: {},
  twitter: {},
  tiktok: {},
};

// ---------------------------------------------------------------------------
// Public error class
// ---------------------------------------------------------------------------

export class SecretsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsParseError";
  }
}

// ---------------------------------------------------------------------------
// Injectable interfaces
// ---------------------------------------------------------------------------

export interface SecretsLogger {
  warn(message: string): void;
}

/** Minimal fs abstraction for loadSecrets. */
export interface SecretsReader {
  readFile(path: string): Promise<Buffer | string>;
  stat(path: string): Promise<{ mode: number }>;
}

/** Minimal fs abstraction for saveSecrets. */
export interface SecretsWriter {
  mkdir(path: string, opts: { recursive: boolean; mode: number }): Promise<unknown>;
  writeFile(path: string, data: string, opts: { mode: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

const noopLogger: SecretsLogger = { warn: () => undefined };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new SecretsParseError(`${path} must be a string (got ${typeof value})`);
  }
  return value;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

// ---------------------------------------------------------------------------
// parseSecrets
// ---------------------------------------------------------------------------

/**
 * Parse TOML text into a LimboSecrets.
 *
 * - Missing tables/fields produce undefined (EMPTY_SECRETS defaults).
 * - Type mismatches throw SecretsParseError.
 */
export function parseSecrets(text: string): LimboSecrets {
  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SecretsParseError(`Failed to parse TOML: ${msg}`);
  }

  // ---- instagram ----
  const rawIg = raw.instagram;
  let instagram: LimboSecrets["instagram"] = {};
  if (rawIg !== undefined) {
    if (!isRecord(rawIg)) {
      throw new SecretsParseError("[instagram] must be a table");
    }
    const igUsername = assertOptionalString(rawIg.username, "[instagram].username");
    const igPassword = assertOptionalString(rawIg.password, "[instagram].password");
    instagram = {
      ...(igUsername !== undefined ? { username: igUsername } : {}),
      ...(igPassword !== undefined ? { password: igPassword } : {}),
    };
  }

  // ---- twitter ----
  const rawTw = raw.twitter;
  let twitter: LimboSecrets["twitter"] = {};
  if (rawTw !== undefined) {
    if (!isRecord(rawTw)) {
      throw new SecretsParseError("[twitter] must be a table");
    }
    const twUsername = assertOptionalString(rawTw.username, "[twitter].username");
    const twPassword = assertOptionalString(rawTw.password, "[twitter].password");
    const twBearer = assertOptionalString(rawTw.bearer_token, "[twitter].bearer_token");
    const twApiKey = assertOptionalString(rawTw.api_key, "[twitter].api_key");
    const twApiSecret = assertOptionalString(rawTw.api_secret, "[twitter].api_secret");
    const twAccessToken = assertOptionalString(rawTw.access_token, "[twitter].access_token");
    const twAccessSecret = assertOptionalString(rawTw.access_secret, "[twitter].access_secret");
    twitter = {
      ...(twUsername !== undefined ? { username: twUsername } : {}),
      ...(twPassword !== undefined ? { password: twPassword } : {}),
      ...(twBearer !== undefined ? { bearerToken: twBearer } : {}),
      ...(twApiKey !== undefined ? { apiKey: twApiKey } : {}),
      ...(twApiSecret !== undefined ? { apiSecret: twApiSecret } : {}),
      ...(twAccessToken !== undefined ? { accessToken: twAccessToken } : {}),
      ...(twAccessSecret !== undefined ? { accessSecret: twAccessSecret } : {}),
    };
  }

  // ---- tiktok ----
  const rawTt = raw.tiktok;
  let tiktok: LimboSecrets["tiktok"] = {};
  if (rawTt !== undefined) {
    if (!isRecord(rawTt)) {
      throw new SecretsParseError("[tiktok] must be a table");
    }
    const ttMsToken = assertOptionalString(rawTt.ms_token, "[tiktok].ms_token");
    tiktok = {
      ...(ttMsToken !== undefined ? { msToken: ttMsToken } : {}),
    };
  }

  return { instagram, twitter, tiktok };
}

// ---------------------------------------------------------------------------
// loadSecrets
// ---------------------------------------------------------------------------

/**
 * Load secrets from a TOML file on disk.
 *
 * - ENOENT → { secrets: EMPTY_SECRETS, loadedFrom: null, insecure: false }
 * - Insecure permissions (group/other read or write bits) → warn + empty + insecure: true
 * - Valid file → parse and return
 */
export async function loadSecrets({
  path,
  fs: fsImpl,
  logger = noopLogger,
}: {
  path: string;
  fs?: SecretsReader;
  logger?: SecretsLogger;
}): Promise<{ secrets: LimboSecrets; loadedFrom: string | null; insecure: boolean }> {
  const defaultFs: SecretsReader = {
    readFile: (p: string) => nodeReadFile(p),
    stat: (p: string) => nodeStat(p),
  };
  const fsRead: SecretsReader = fsImpl ?? defaultFs;

  // Check existence and permissions via stat
  let statResult: { mode: number };
  try {
    statResult = await fsRead.stat(path);
  } catch (err) {
    if (isEnoent(err)) {
      return { secrets: EMPTY_SECRETS, loadedFrom: null, insecure: false };
    }
    throw err;
  }

  // Check for insecure permissions: any group or other read/write bits set
  if ((statResult.mode & 0o077) !== 0) {
    logger.warn(
      `WARNING: secrets.toml has insecure perms — refusing to load. Run \`chmod 0600 ${path}\` to fix.`,
    );
    return { secrets: EMPTY_SECRETS, loadedFrom: null, insecure: true };
  }

  // Read and parse
  let text: string;
  try {
    const buf = await fsRead.readFile(path);
    text = buf.toString();
  } catch (err) {
    if (isEnoent(err)) {
      return { secrets: EMPTY_SECRETS, loadedFrom: null, insecure: false };
    }
    throw err;
  }

  const secrets = parseSecrets(text);
  return { secrets, loadedFrom: path, insecure: false };
}

// ---------------------------------------------------------------------------
// saveSecrets
// ---------------------------------------------------------------------------

/**
 * Atomically persist secrets to disk.
 *
 * - Ensures parent directory exists at mode 0700.
 * - Writes to <path>.tmp at mode 0600, then renames to <path>.
 */
export async function saveSecrets({
  path,
  secrets,
  fs: fsImpl,
}: {
  path: string;
  secrets: LimboSecrets;
  fs?: SecretsWriter;
}): Promise<void> {
  const defaultFs: SecretsWriter = {
    mkdir: (p: string, opts: { recursive: boolean; mode: number }) => nodeMkdir(p, opts),
    writeFile: (p: string, data: string, opts: { mode: number }) => nodeWriteFile(p, data, opts),
    rename: (oldPath: string, newPath: string) => nodeRename(oldPath, newPath),
  };
  const fsWrite: SecretsWriter = fsImpl ?? defaultFs;

  // Ensure parent directory at mode 0700
  const dir = dirname(path);
  await fsWrite.mkdir(dir, { recursive: true, mode: 0o700 });

  // Build TOML — only include non-empty sub-tables
  const tomlObj: JsonMap = {};

  const ig = secrets.instagram;
  if (ig.username !== undefined || ig.password !== undefined) {
    const igMap: JsonMap = {};
    if (ig.username !== undefined) igMap.username = ig.username;
    if (ig.password !== undefined) igMap.password = ig.password;
    tomlObj.instagram = igMap;
  }

  const tw = secrets.twitter;
  if (
    tw.username !== undefined ||
    tw.password !== undefined ||
    tw.bearerToken !== undefined ||
    tw.apiKey !== undefined ||
    tw.apiSecret !== undefined ||
    tw.accessToken !== undefined ||
    tw.accessSecret !== undefined
  ) {
    const twMap: JsonMap = {};
    if (tw.username !== undefined) twMap.username = tw.username;
    if (tw.password !== undefined) twMap.password = tw.password;
    if (tw.bearerToken !== undefined) twMap.bearer_token = tw.bearerToken;
    if (tw.apiKey !== undefined) twMap.api_key = tw.apiKey;
    if (tw.apiSecret !== undefined) twMap.api_secret = tw.apiSecret;
    if (tw.accessToken !== undefined) twMap.access_token = tw.accessToken;
    if (tw.accessSecret !== undefined) twMap.access_secret = tw.accessSecret;
    tomlObj.twitter = twMap;
  }

  const tt = secrets.tiktok;
  if (tt.msToken !== undefined) {
    tomlObj.tiktok = { ms_token: tt.msToken };
  }

  const tomlText = stringify(tomlObj);
  const tmpPath = `${path}.tmp`;

  // Write to tmp at mode 0600
  await fsWrite.writeFile(tmpPath, tomlText, { mode: 0o600 });

  // Atomic rename
  await fsWrite.rename(tmpPath, path);
}

// ---------------------------------------------------------------------------
// secretsToEnv
// ---------------------------------------------------------------------------

/**
 * Derive a NodeJS.ProcessEnv subset from secrets.
 *
 * Keys are only included when the corresponding secret field is defined.
 * Merge with: { ...secretsToEnv(s), ...processEnv } so explicit env vars trump file-based ones.
 */
export function secretsToEnv(secrets: LimboSecrets): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};

  const ig = secrets.instagram;
  if (ig.username !== undefined) env.LIMBO_IG_USERNAME = ig.username;
  if (ig.password !== undefined) env.LIMBO_IG_PASSWORD = ig.password;

  const tw = secrets.twitter;
  if (tw.username !== undefined) env.LIMBO_TWITTER_USERNAME = tw.username;
  if (tw.password !== undefined) env.LIMBO_TWITTER_PASSWORD = tw.password;
  if (tw.bearerToken !== undefined) env.TWITTER_BEARER_TOKEN = tw.bearerToken;
  if (tw.apiKey !== undefined) env.TWITTER_API_KEY = tw.apiKey;
  if (tw.apiSecret !== undefined) env.TWITTER_API_SECRET = tw.apiSecret;
  if (tw.accessToken !== undefined) env.TWITTER_ACCESS_TOKEN = tw.accessToken;
  if (tw.accessSecret !== undefined) env.TWITTER_ACCESS_SECRET = tw.accessSecret;

  const tt = secrets.tiktok;
  if (tt.msToken !== undefined) env.LIMBO_TIKTOK_MS_TOKEN = tt.msToken;

  return env;
}

// ---------------------------------------------------------------------------
// mergeSecrets — shallow-merge partial secrets into existing LimboSecrets
// ---------------------------------------------------------------------------

export function mergeSecrets(base: LimboSecrets, patch: Partial<LimboSecrets>): LimboSecrets {
  return {
    instagram: { ...base.instagram, ...patch.instagram },
    twitter: { ...base.twitter, ...patch.twitter },
    tiktok: { ...base.tiktok, ...patch.tiktok },
  };
}
