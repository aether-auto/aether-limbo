import { describe, expect, it, vi } from "vitest";
import { resolveEditor, runConfigEdit } from "./config-edit.js";
import type { ConfigEditDeps } from "./config-edit.js";

// ---------------------------------------------------------------------------
// resolveEditor
// ---------------------------------------------------------------------------

describe("resolveEditor", () => {
  it("returns $VISUAL when set", () => {
    expect(resolveEditor({ VISUAL: "code", EDITOR: "vim" })).toBe("code");
  });

  it("falls back to $EDITOR when VISUAL unset", () => {
    expect(resolveEditor({ EDITOR: "vim" })).toBe("vim");
  });

  it("falls back to nano when neither is set", () => {
    expect(resolveEditor({})).toBe("nano");
  });
});

// ---------------------------------------------------------------------------
// runConfigEdit
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<ConfigEditDeps> = {}): ConfigEditDeps {
  const stderr: string[] = [];
  return {
    configPath: "/home/user/.config/aether-limbo/config.toml",
    env: {},
    spawnSync: vi.fn().mockReturnValue({ status: 0, error: undefined }),
    fs: { exists: vi.fn().mockReturnValue(true) },
    stderr: { write: (s: string) => stderr.push(s) },
    ensureConfig: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("runConfigEdit", () => {
  it("spawns $VISUAL when set and file exists", async () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, error: undefined });
    const exitCode = await runConfigEdit(
      makeDeps({ env: { VISUAL: "code", EDITOR: "vim" }, spawnSync }),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "code",
      ["/home/user/.config/aether-limbo/config.toml"],
      { stdio: "inherit" },
    );
    expect(exitCode).toBe(0);
  });

  it("falls back to $EDITOR when VISUAL not set", async () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, error: undefined });
    await runConfigEdit(makeDeps({ env: { EDITOR: "vim" }, spawnSync }));
    expect(spawnSync).toHaveBeenCalledWith("vim", expect.any(Array), expect.any(Object));
  });

  it("falls back nano → vi when neither env var set and nano not found", async () => {
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        error: Object.assign(new Error("not found"), { code: "ENOENT" }),
      })
      .mockReturnValue({ status: 0, error: undefined });
    await runConfigEdit(makeDeps({ env: {}, spawnSync }));
    expect(spawnSync).toHaveBeenCalledTimes(2);
    const calls = spawnSync.mock.calls as Array<[string, string[], unknown]>;
    expect(calls[0]?.[0]).toBe("nano");
    expect(calls[1]?.[0]).toBe("vi");
  });

  it("returns editor's exit code", async () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 42, error: undefined });
    const code = await runConfigEdit(makeDeps({ env: { VISUAL: "code" }, spawnSync }));
    expect(code).toBe(42);
  });

  it("calls ensureConfig when file is missing, then opens editor", async () => {
    const ensureConfig = vi.fn().mockResolvedValue(undefined);
    const spawnSync = vi.fn().mockReturnValue({ status: 0, error: undefined });
    const fs = { exists: vi.fn().mockReturnValue(false) };
    await runConfigEdit(makeDeps({ ensureConfig, spawnSync, fs, env: { EDITOR: "vim" } }));
    expect(ensureConfig).toHaveBeenCalledOnce();
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  it("does NOT call ensureConfig when file exists", async () => {
    const ensureConfig = vi.fn().mockResolvedValue(undefined);
    await runConfigEdit(makeDeps({ ensureConfig, fs: { exists: vi.fn().mockReturnValue(true) } }));
    expect(ensureConfig).not.toHaveBeenCalled();
  });

  it("returns 1 and writes to stderr when all editors fail", async () => {
    const stderrOut: string[] = [];
    const spawnSync = vi
      .fn()
      .mockReturnValue({ status: 0, error: Object.assign(new Error("nf"), { code: "ENOENT" }) });
    const code = await runConfigEdit(
      makeDeps({
        env: {},
        spawnSync,
        stderr: { write: (s) => stderrOut.push(s) },
      }),
    );
    expect(code).toBe(1);
    expect(stderrOut.join("")).toContain("could not find an editor");
  });
});
