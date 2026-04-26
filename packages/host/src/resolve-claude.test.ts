import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeNotFoundError, isExecutableFile, resolveClaudeBin } from "./resolve-claude.js";

function makeExec(dir: string, name: string, body = "#!/bin/sh\nexit 0\n"): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

describe("isExecutableFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "limbo-isexec-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false for a path that does not exist", () => {
    expect(isExecutableFile(join(dir, "missing"))).toBe(false);
  });

  it("returns false for a non-executable regular file", () => {
    const p = join(dir, "plain.txt");
    writeFileSync(p, "hi");
    chmodSync(p, 0o644);
    expect(isExecutableFile(p)).toBe(false);
  });

  it("returns false for a directory", () => {
    expect(isExecutableFile(dir)).toBe(false);
  });

  it("returns true for an executable file", () => {
    expect(isExecutableFile(makeExec(dir, "ok"))).toBe(true);
  });
});

describe("resolveClaudeBin", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "limbo-resolve-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns $CLAUDE_BIN when it points at an executable file", () => {
    const fake = makeExec(dir, "claude-override");
    expect(resolveClaudeBin({ CLAUDE_BIN: fake } as NodeJS.ProcessEnv)).toBe(fake);
  });

  it("ignores empty $CLAUDE_BIN and falls through to PATH", () => {
    const onPath = makeExec(dir, "claude");
    const result = resolveClaudeBin({ CLAUDE_BIN: "", PATH: dir } as NodeJS.ProcessEnv);
    expect(result).toBe(onPath);
  });

  it("throws ClaudeNotFoundError when $CLAUDE_BIN points at a missing file", () => {
    const bogus = join(dir, "does-not-exist");
    expect(() => resolveClaudeBin({ CLAUDE_BIN: bogus } as NodeJS.ProcessEnv)).toThrow(
      ClaudeNotFoundError,
    );
  });

  it("throws with a CLAUDE_BIN-specific message when override is invalid", () => {
    const bogus = join(dir, "nope");
    try {
      resolveClaudeBin({ CLAUDE_BIN: bogus } as NodeJS.ProcessEnv);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeNotFoundError);
      const e = err as ClaudeNotFoundError;
      expect(e.message).toContain("$CLAUDE_BIN");
      expect(e.overrideAttempted).toBe(bogus);
    }
  });

  it("throws when $CLAUDE_BIN points at a non-executable file", () => {
    const f = join(dir, "claude-not-exec");
    writeFileSync(f, "");
    chmodSync(f, 0o644);
    expect(() => resolveClaudeBin({ CLAUDE_BIN: f } as NodeJS.ProcessEnv)).toThrow(/CLAUDE_BIN/);
  });

  it("walks $PATH and finds the first executable named claude", () => {
    const found = makeExec(dir, "claude");
    expect(resolveClaudeBin({ PATH: dir } as NodeJS.ProcessEnv)).toBe(found);
  });

  it("returns the first match when claude exists in multiple PATH entries", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "limbo-resolve2-"));
    try {
      const first = makeExec(dir, "claude");
      makeExec(dir2, "claude");
      const path = `${dir}${delimiter}${dir2}`;
      expect(resolveClaudeBin({ PATH: path } as NodeJS.ProcessEnv)).toBe(first);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("skips empty PATH entries without crashing", () => {
    const found = makeExec(dir, "claude");
    const path = `${delimiter}${delimiter}${dir}${delimiter}`;
    expect(resolveClaudeBin({ PATH: path } as NodeJS.ProcessEnv)).toBe(found);
  });

  it("throws ClaudeNotFoundError listing searched dirs when not on PATH", () => {
    try {
      resolveClaudeBin({ PATH: dir } as NodeJS.ProcessEnv);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeNotFoundError);
      const e = err as ClaudeNotFoundError;
      expect(e.searched).toContain(join(dir, "claude"));
      expect(e.overrideAttempted).toBeUndefined();
      expect(e.message).toContain("could not find 'claude'");
    }
  });

  it("throws with empty searched[] when PATH is undefined and no override", () => {
    try {
      resolveClaudeBin({} as NodeJS.ProcessEnv);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeNotFoundError);
      expect((err as ClaudeNotFoundError).searched).toHaveLength(0);
    }
  });
});
