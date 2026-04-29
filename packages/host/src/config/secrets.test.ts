import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_SECRETS,
  SecretsParseError,
  type SecretsReader,
  type SecretsWriter,
  loadSecrets,
  parseSecrets,
  saveSecrets,
  secretsToEnv,
} from "./secrets.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatFs(mode: number, content: string): SecretsReader {
  return {
    stat: async (_p: string) => ({ mode }),
    lstat: async (_p: string) => ({ mode }),
    readFile: async (_p: string) => Buffer.from(content),
  };
}

function makeEnoentFs(): SecretsReader {
  return {
    stat: async (_p: string) => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    lstat: async (_p: string) => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    readFile: async (_p: string) => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
}

// ---------------------------------------------------------------------------
// parseSecrets — happy path
// ---------------------------------------------------------------------------

describe("parseSecrets — full TOML", () => {
  const toml = `
[instagram]
username = "alice"
password = "s3cr3t"

[twitter]
username = "xuser"
password = "xpass"
bearer_token = "bt"
api_key = "ak"
api_secret = "as"
access_token = "at"
access_secret = "asc"

[tiktok]
ms_token = "tok123"
`;
  const s = parseSecrets(toml);

  it("parses instagram username and password", () => {
    expect(s.instagram.username).toBe("alice");
    expect(s.instagram.password).toBe("s3cr3t");
  });

  it("parses twitter twikit username and password", () => {
    expect(s.twitter.username).toBe("xuser");
    expect(s.twitter.password).toBe("xpass");
  });

  it("parses twitter API fields", () => {
    expect(s.twitter.bearerToken).toBe("bt");
    expect(s.twitter.apiKey).toBe("ak");
    expect(s.twitter.apiSecret).toBe("as");
    expect(s.twitter.accessToken).toBe("at");
    expect(s.twitter.accessSecret).toBe("asc");
  });

  it("parses tiktok ms_token", () => {
    expect(s.tiktok.msToken).toBe("tok123");
  });
});

describe("parseSecrets — empty TOML returns EMPTY_SECRETS shape", () => {
  it("all fields undefined on empty input", () => {
    const s = parseSecrets("");
    expect(s.instagram.username).toBeUndefined();
    expect(s.twitter.bearerToken).toBeUndefined();
    expect(s.tiktok.msToken).toBeUndefined();
  });
});

describe("parseSecrets — partial TOML", () => {
  it("only instagram table", () => {
    const s = parseSecrets('[instagram]\nusername = "bob"');
    expect(s.instagram.username).toBe("bob");
    expect(s.instagram.password).toBeUndefined();
    expect(s.tiktok.msToken).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseSecrets — type mismatch throws
// ---------------------------------------------------------------------------

describe("parseSecrets — type mismatches throw SecretsParseError", () => {
  it("instagram.username as number throws", () => {
    expect(() => parseSecrets("[instagram]\nusername = 42")).toThrow(SecretsParseError);
    expect(() => parseSecrets("[instagram]\nusername = 42")).toThrow("[instagram].username");
  });

  it("tiktok.ms_token as boolean throws", () => {
    expect(() => parseSecrets("[tiktok]\nms_token = true")).toThrow(SecretsParseError);
  });

  it("twitter table as non-table throws", () => {
    expect(() => parseSecrets("twitter = 99")).toThrow(SecretsParseError);
  });

  it("invalid TOML syntax throws SecretsParseError", () => {
    expect(() => parseSecrets("[[not valid = ")).toThrow(SecretsParseError);
  });
});

// ---------------------------------------------------------------------------
// loadSecrets — ENOENT
// ---------------------------------------------------------------------------

describe("loadSecrets — ENOENT returns empty + loadedFrom null", () => {
  it("returns EMPTY_SECRETS and loadedFrom null", async () => {
    const result = await loadSecrets({
      path: "/no/such/secrets.toml",
      fs: makeEnoentFs(),
    });
    expect(result.secrets).toEqual(EMPTY_SECRETS);
    expect(result.loadedFrom).toBeNull();
    expect(result.insecure).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadSecrets — insecure permissions
// ---------------------------------------------------------------------------

describe("loadSecrets — insecure perms (0o644)", () => {
  it("returns empty, insecure:true, and logs a warning", async () => {
    const logger = { warn: vi.fn() };
    const result = await loadSecrets({
      path: "/home/user/.config/aether-limbo/secrets.toml",
      fs: makeStatFs(0o100644, '[tiktok]\nms_token = "tok"'),
      logger,
    });
    expect(result.secrets).toEqual(EMPTY_SECRETS);
    expect(result.loadedFrom).toBeNull();
    expect(result.insecure).toBe(true);
    expect(logger.warn).toHaveBeenCalledOnce();
    const warnArg = logger.warn.mock.calls[0]?.[0] as string;
    expect(warnArg).toContain("insecure perms");
  });
});

describe("loadSecrets — insecure perms (0o755, group execute bit)", () => {
  it("returns insecure:true for group execute", async () => {
    const logger = { warn: vi.fn() };
    const result = await loadSecrets({
      path: "/cfg/secrets.toml",
      fs: makeStatFs(0o100755, ""),
      logger,
    });
    expect(result.insecure).toBe(true);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// loadSecrets — symlink refusal
// ---------------------------------------------------------------------------

describe("loadSecrets — symlink at secrets.toml is refused", () => {
  it("returns empty, insecure:true, and logs a warning when lstat reports a symlink", async () => {
    // S_IFLNK (0o120000) combined with typical rwx bits = 0o120777
    const symlinkMode = 0o120777;
    const logger = { warn: vi.fn() };
    const result = await loadSecrets({
      path: "/home/user/.config/aether-limbo/secrets.toml",
      fs: makeStatFs(symlinkMode, '[tiktok]\nms_token = "tok"'),
      logger,
    });
    expect(result.secrets).toEqual(EMPTY_SECRETS);
    expect(result.loadedFrom).toBeNull();
    expect(result.insecure).toBe(true);
    expect(logger.warn).toHaveBeenCalledOnce();
    const warnArg = logger.warn.mock.calls[0]?.[0] as string;
    expect(warnArg).toContain("symlink");
  });
});

// ---------------------------------------------------------------------------
// loadSecrets — secure perms (0o600)
// ---------------------------------------------------------------------------

describe("loadSecrets — secure perms (0o600) parses and returns", () => {
  it("returns parsed secrets and loadedFrom path", async () => {
    const toml = '[tiktok]\nms_token = "mytoken"';
    const result = await loadSecrets({
      path: "/cfg/secrets.toml",
      fs: makeStatFs(0o100600, toml),
    });
    expect(result.loadedFrom).toBe("/cfg/secrets.toml");
    expect(result.insecure).toBe(false);
    expect(result.secrets.tiktok.msToken).toBe("mytoken");
  });
});

// ---------------------------------------------------------------------------
// saveSecrets — atomic write flow
// ---------------------------------------------------------------------------

describe("saveSecrets — atomic write creates parent dir, writes .tmp at 0600, renames", () => {
  it("calls mkdir, writeFile with 0o600, then rename", async () => {
    const calls: string[] = [];
    const fsWriter: SecretsWriter = {
      mkdir: async (p, opts) => {
        calls.push(`mkdir:${p}:recursive=${opts.recursive}:mode=${opts.mode.toString(8)}`);
      },
      writeFile: async (p, _data, opts) => {
        calls.push(`writeFile:${p}:mode=${opts.mode.toString(8)}`);
      },
      rename: async (src, dst) => {
        calls.push(`rename:${src}->${dst}`);
      },
    };

    await saveSecrets({
      path: "/home/user/.config/aether-limbo/secrets.toml",
      secrets: { instagram: { username: "alice" }, twitter: {}, tiktok: {} },
      fs: fsWriter,
    });

    expect(calls[0]).toContain("mkdir");
    expect(calls[0]).toContain("recursive=true");
    expect(calls[0]).toContain("mode=700");
    expect(calls[1]).toContain("writeFile");
    expect(calls[1]).toContain("secrets.toml.tmp");
    expect(calls[1]).toContain("mode=600");
    expect(calls[2]).toContain("rename");
    // src is .tmp, dst is final path
    expect(calls[2]).toContain("secrets.toml.tmp");
    expect(calls[2]).toMatch(/->.*secrets\.toml$/);
  });

  it("rename destination is the original path (not .tmp)", async () => {
    let renameDst = "";
    const fsWriter: SecretsWriter = {
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      rename: async (_src, dst) => {
        renameDst = dst;
      },
    };
    await saveSecrets({
      path: "/cfg/s.toml",
      secrets: EMPTY_SECRETS,
      fs: fsWriter,
    });
    expect(renameDst).toBe("/cfg/s.toml");
  });
});

describe("saveSecrets — empty sub-tables are omitted from TOML", () => {
  it("EMPTY_SECRETS produces empty TOML (no tables)", async () => {
    let written = "";
    const fsWriter: SecretsWriter = {
      mkdir: async () => undefined,
      writeFile: async (_p, data) => {
        written = data;
      },
      rename: async () => undefined,
    };
    await saveSecrets({ path: "/cfg/s.toml", secrets: EMPTY_SECRETS, fs: fsWriter });
    // No [instagram], [twitter], [tiktok] tables when all fields are undefined
    expect(written).not.toContain("[instagram]");
    expect(written).not.toContain("[twitter]");
    expect(written).not.toContain("[tiktok]");
  });

  it("twitter username+password → [twitter] table with username and password keys", async () => {
    let written = "";
    const fsWriter: SecretsWriter = {
      mkdir: async () => undefined,
      writeFile: async (_p, data) => {
        written = data;
      },
      rename: async () => undefined,
    };
    const secrets = {
      instagram: {},
      twitter: { username: "xuser", password: "xpass" },
      tiktok: {},
    };
    await saveSecrets({ path: "/cfg/s.toml", secrets, fs: fsWriter });
    expect(written).toContain("[twitter]");
    expect(written).toContain("xuser");
    expect(written).toContain("xpass");
    expect(written).not.toContain("[instagram]");
    expect(written).not.toContain("[tiktok]");
  });

  it("only tiktok populated → only [tiktok] in output", async () => {
    let written = "";
    const fsWriter: SecretsWriter = {
      mkdir: async () => undefined,
      writeFile: async (_p, data) => {
        written = data;
      },
      rename: async () => undefined,
    };
    const secrets = { instagram: {}, twitter: {}, tiktok: { msToken: "tok" } };
    await saveSecrets({ path: "/cfg/s.toml", secrets, fs: fsWriter });
    expect(written).toContain("[tiktok]");
    expect(written).toContain("ms_token");
    expect(written).not.toContain("[instagram]");
    expect(written).not.toContain("[twitter]");
  });
});

// ---------------------------------------------------------------------------
// secretsToEnv
// ---------------------------------------------------------------------------

describe("secretsToEnv — full secrets maps to expected env vars", () => {
  it("all fields produce the correct keys", () => {
    const env = secretsToEnv({
      instagram: { username: "alice", password: "pw" },
      twitter: {
        username: "xuser",
        password: "xpass",
        bearerToken: "bt",
        apiKey: "ak",
        apiSecret: "as",
        accessToken: "at",
        accessSecret: "asc",
      },
      tiktok: { msToken: "tok" },
    });
    expect(env.LIMBO_IG_USERNAME).toBe("alice");
    expect(env.LIMBO_IG_PASSWORD).toBe("pw");
    expect(env.LIMBO_TWITTER_USERNAME).toBe("xuser");
    expect(env.LIMBO_TWITTER_PASSWORD).toBe("xpass");
    expect(env.TWITTER_BEARER_TOKEN).toBe("bt");
    expect(env.TWITTER_API_KEY).toBe("ak");
    expect(env.TWITTER_API_SECRET).toBe("as");
    expect(env.TWITTER_ACCESS_TOKEN).toBe("at");
    expect(env.TWITTER_ACCESS_SECRET).toBe("asc");
    expect(env.LIMBO_TIKTOK_MS_TOKEN).toBe("tok");
  });

  it("undefined fields are absent from the env map", () => {
    const env = secretsToEnv(EMPTY_SECRETS);
    expect("LIMBO_IG_USERNAME" in env).toBe(false);
    expect("LIMBO_IG_PASSWORD" in env).toBe(false);
    expect("LIMBO_TWITTER_USERNAME" in env).toBe(false);
    expect("LIMBO_TWITTER_PASSWORD" in env).toBe(false);
    expect("TWITTER_BEARER_TOKEN" in env).toBe(false);
    expect("LIMBO_TIKTOK_MS_TOKEN" in env).toBe(false);
  });

  it("partial secrets only include defined keys", () => {
    const env = secretsToEnv({
      instagram: { username: "bob" },
      twitter: {},
      tiktok: {},
    });
    expect(env.LIMBO_IG_USERNAME).toBe("bob");
    expect("LIMBO_IG_PASSWORD" in env).toBe(false);
    expect("LIMBO_TWITTER_USERNAME" in env).toBe(false);
    expect("TWITTER_BEARER_TOKEN" in env).toBe(false);
  });

  it("twitter username/password only → LIMBO_TWITTER_USERNAME and LIMBO_TWITTER_PASSWORD set", () => {
    const env = secretsToEnv({
      instagram: {},
      twitter: { username: "xuser", password: "xpass" },
      tiktok: {},
    });
    expect(env.LIMBO_TWITTER_USERNAME).toBe("xuser");
    expect(env.LIMBO_TWITTER_PASSWORD).toBe("xpass");
    expect("TWITTER_BEARER_TOKEN" in env).toBe(false);
  });
});

describe("secretsToEnv — process env trumps secrets", () => {
  it("merging { ...secretsToEnv, ...processEnv } lets processEnv win", () => {
    const secretsEnv = secretsToEnv({
      instagram: { username: "from-file" },
      twitter: {},
      tiktok: {},
    });
    const processEnv = { LIMBO_IG_USERNAME: "from-process" };
    const merged = { ...secretsEnv, ...processEnv };
    expect(merged.LIMBO_IG_USERNAME).toBe("from-process");
  });
});
