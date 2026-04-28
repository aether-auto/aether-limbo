import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "./defaults.js";
import { ConfigParseError, type FsReader, loadConfig, parseConfig } from "./loader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFs(content: string): FsReader {
  return {
    readFile: async (_p: string) => Buffer.from(content),
  };
}

function makeEnoentFs(): FsReader {
  return {
    readFile: async (_p: string) => {
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      throw err;
    },
  };
}

function makeErrorFs(code: string): FsReader {
  return {
    readFile: async (_p: string) => {
      throw Object.assign(new Error(code), { code });
    },
  };
}

// ---------------------------------------------------------------------------
// parseConfig — happy path
// ---------------------------------------------------------------------------

describe("parseConfig — happy path (fully populated TOML)", () => {
  const toml = `
[hotkey]
chord = "\\u001b[24~"

[guard]
message = "stop scrolling"
hold_ms = 2000
idle_attempts_before_escalation = 3
escalation_messages = ["seriously", "last warning"]

[snapback]
enabled = false

[adapters]
tab_order = ["x", "tiktok"]
keep_warm = true

[adapters.enabled]
x = true
tiktok = false

[adapters.instagram]
thumbnails = false
thumbnail_max_rows = 3

[adapters.twitter]
auth = "tweepy"
cache_dms = true
language = "fr-FR"

[adapters.tiktok]
refresh_on_failure = true
keep_warm = true
`;

  const config = parseConfig(toml);

  it("parses hotkey chord", () => {
    //  in TOML decodes to ESC (0x1b)
    expect(config.hotkey.chord).toBe("\x1b[24~");
    expect(config.hotkey.chord.charCodeAt(0)).toBe(0x1b);
  });

  it("parses guard section", () => {
    expect(config.guard.message).toBe("stop scrolling");
    expect(config.guard.holdMs).toBe(2000);
    expect(config.guard.idleAttemptsBeforeEscalation).toBe(3);
    expect(config.guard.escalationMessages).toEqual(["seriously", "last warning"]);
  });

  it("parses snapback section", () => {
    expect(config.snapback.enabled).toBe(false);
  });

  it("parses adapters section", () => {
    expect(config.adapters.tabOrder).toEqual(["x", "tiktok"]);
    expect(config.adapters.keepWarm).toBe(true);
    expect(config.adapters.enabled.x).toBe(true);
    expect(config.adapters.enabled.tiktok).toBe(false);
  });

  it("parses instagram sub-section", () => {
    expect(config.adapters.instagram.thumbnails).toBe(false);
    expect(config.adapters.instagram.thumbnailMaxRows).toBe(3);
  });

  it("parses twitter sub-section", () => {
    expect(config.adapters.twitter.auth).toBe("tweepy");
    expect(config.adapters.twitter.cacheDms).toBe(true);
    expect(config.adapters.twitter.language).toBe("fr-FR");
  });

  it("parses tiktok sub-section", () => {
    expect(config.adapters.tiktok.refreshOnFailure).toBe(true);
    expect(config.adapters.tiktok.keepWarm).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseConfig — escape sequences
//
// TOML basic strings use \uXXXX (not \xXX — that is NOT in the TOML spec).
// @iarna/toml correctly parses  → U+000C (form feed / Ctrl+L).
// ---------------------------------------------------------------------------

describe("parseConfig — TOML escape sequences in chord", () => {
  it('chord = "\\u000c" → single byte 0x0c (Ctrl+L)', () => {
    // The raw TOML text contains the 6-char sequence
    const tomlText = '[hotkey]\nchord = "\\u000c"';
    const config = parseConfig(tomlText);
    expect(config.hotkey.chord).toBe("\x0c");
    expect(config.hotkey.chord.length).toBe(1);
    expect(config.hotkey.chord.charCodeAt(0)).toBe(0x0c);
  });

  it('chord = "\\u001b[24~" → 5-char F12 escape sequence', () => {
    const tomlText = '[hotkey]\nchord = "\\u001b[24~"';
    const config = parseConfig(tomlText);
    expect(config.hotkey.chord).toBe("\x1b[24~");
    expect(config.hotkey.chord.length).toBe(5);
    expect(config.hotkey.chord.charCodeAt(0)).toBe(0x1b);
  });
});

// ---------------------------------------------------------------------------
// parseConfig — missing sections fall back to defaults
// ---------------------------------------------------------------------------

describe("parseConfig — missing sections fallback", () => {
  it("empty TOML returns DEFAULT_CONFIG", () => {
    const config = parseConfig("");
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("missing [hotkey] section falls back to default chord", () => {
    const config = parseConfig("[snapback]\nenabled = false");
    expect(config.hotkey.chord).toBe(DEFAULT_CONFIG.hotkey.chord);
  });

  it("missing [guard] section falls back to defaults", () => {
    const config = parseConfig('[hotkey]\nchord = "\\u000c"');
    expect(config.guard).toEqual(DEFAULT_CONFIG.guard);
  });

  it("missing [snapback] section falls back to enabled = true", () => {
    const config = parseConfig('[hotkey]\nchord = "\\u000c"');
    expect(config.snapback.enabled).toBe(true);
  });

  it("missing [adapters] section falls back to defaults", () => {
    const config = parseConfig('[hotkey]\nchord = "\\u000c"');
    expect(config.adapters).toEqual(DEFAULT_CONFIG.adapters);
  });
});

// ---------------------------------------------------------------------------
// parseConfig — missing field within section falls back to default
// ---------------------------------------------------------------------------

describe("parseConfig — missing field within section", () => {
  it("[guard] with only message falls back to default holdMs", () => {
    const config = parseConfig('[guard]\nmessage = "custom"');
    expect(config.guard.holdMs).toBe(DEFAULT_CONFIG.guard.holdMs);
  });

  it("[adapters.twitter] with only auth falls back to default language", () => {
    const config = parseConfig('[adapters.twitter]\nauth = "tweepy"');
    expect(config.adapters.twitter.language).toBe(DEFAULT_CONFIG.adapters.twitter.language);
  });
});

// ---------------------------------------------------------------------------
// parseConfig — invalid types throw ConfigParseError
// ---------------------------------------------------------------------------

describe("parseConfig — invalid types throw ConfigParseError", () => {
  it("[hotkey] chord as number throws with field path in message", () => {
    expect(() => parseConfig("[hotkey]\nchord = 12")).toThrow(ConfigParseError);
    expect(() => parseConfig("[hotkey]\nchord = 12")).toThrow("[hotkey].chord");
  });

  it("[guard] hold_ms as string throws", () => {
    expect(() => parseConfig('[guard]\nhold_ms = "fast"')).toThrow(ConfigParseError);
    expect(() => parseConfig('[guard]\nhold_ms = "fast"')).toThrow("[guard].hold_ms");
  });

  it("[snapback] enabled as string throws", () => {
    expect(() => parseConfig('[snapback]\nenabled = "yes"')).toThrow(ConfigParseError);
  });

  it("[adapters.twitter] auth with invalid value throws", () => {
    expect(() => parseConfig('[adapters.twitter]\nauth = "oauth"')).toThrow(ConfigParseError);
    expect(() => parseConfig('[adapters.twitter]\nauth = "oauth"')).toThrow(
      "[adapters.twitter].auth",
    );
  });

  it("invalid TOML syntax throws ConfigParseError", () => {
    expect(() => parseConfig("[[not valid toml = ")).toThrow(ConfigParseError);
  });
});

// ---------------------------------------------------------------------------
// parseConfig — unrecognised section warns via injected logger
// ---------------------------------------------------------------------------

describe("parseConfig — unrecognised section warns via logger", () => {
  it("unknown top-level section triggers warn and still returns config", () => {
    const logger = { warn: vi.fn() };
    const config = parseConfig("[unknown_section]\nfoo = 1", "config.toml", logger);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("unknown_section"));
    // Config still loads with defaults
    expect(config.hotkey.chord).toBe(DEFAULT_CONFIG.hotkey.chord);
  });

  it("multiple unknown sections each trigger a warn call", () => {
    const logger = { warn: vi.fn() };
    parseConfig("[foo]\na = 1\n[bar]\nb = 2", "config.toml", logger);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// loadConfig — file system integration
// ---------------------------------------------------------------------------

describe("loadConfig — ENOENT returns DEFAULT_CONFIG with loadedFrom null", () => {
  it("returns { config: DEFAULT_CONFIG, loadedFrom: null } on ENOENT", async () => {
    const result = await loadConfig({ path: "/no/such/file.toml", fs: makeEnoentFs() });
    expect(result.loadedFrom).toBeNull();
    expect(result.config).toEqual(DEFAULT_CONFIG);
  });
});

describe("loadConfig — happy path reads and parses file", () => {
  it("returns parsed config and loadedFrom path", async () => {
    // Use TOML-native \uXXXX escape (not \xXX which is invalid TOML)
    const toml = '[hotkey]\nchord = "\\u000c"';
    const result = await loadConfig({ path: "/cfg/config.toml", fs: makeFs(toml) });
    expect(result.loadedFrom).toBe("/cfg/config.toml");
    expect(result.config.hotkey.chord).toBe("\x0c");
  });
});

describe("loadConfig — non-ENOENT errors propagate", () => {
  it("propagates EACCES without swallowing", async () => {
    await expect(
      loadConfig({ path: "/cfg/config.toml", fs: makeErrorFs("EACCES") }),
    ).rejects.toThrow("EACCES");
  });
});

describe("loadConfig — parse error propagates", () => {
  it("propagates ConfigParseError from malformed TOML", async () => {
    await expect(
      loadConfig({ path: "/cfg/config.toml", fs: makeFs("[hotkey]\nchord = 99") }),
    ).rejects.toThrow(ConfigParseError);
  });
});
