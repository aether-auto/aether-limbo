import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as ptySpawn } from "node-pty";
import { describe, expect, it } from "vitest";
import { resolveClaudeBin } from "../src/resolve-claude.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "..", "dist", "cli.js");

function findClaude(): string | null {
  try {
    return resolveClaudeBin();
  } catch {
    return null;
  }
}

const claudeBin = findClaude();
const skipReason =
  claudeBin === null
    ? "no 'claude' on $PATH — skipping acceptance vs bare claude"
    : !existsSync(CLI)
      ? "dist/cli.js not built — run pnpm build"
      : null;
const describeIfReady = skipReason ? describe.skip : describe;
if (skipReason) console.warn(`[acceptance] skipping: ${skipReason}`);

interface RunResult {
  output: string;
  exitCode: number;
  signal: number | undefined;
}

function runUnderPty(file: string, args: string[]): Promise<RunResult> {
  return new Promise((resolveRun) => {
    let output = "";
    const child = ptySpawn(file, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: HERE,
      env: process.env as Record<string, string>,
    });
    child.onData((d) => {
      output += d;
    });
    child.onExit((e) => {
      resolveRun({
        output,
        exitCode: e.exitCode,
        signal: e.signal === 0 ? undefined : e.signal,
      });
    });
  });
}

/**
 * Collapse runs of CR to a single CR. `\r` is "cursor to column 0" — idempotent
 * — so `\r\n` and `\r\r\n` render identically on every terminal. The wrapper
 * picks up one extra cooking pass for non-TUI output (inner PTY cooks `\n`→`\r\n`,
 * outer terminal cooks again to `\r\r\n`); terminals collapse the duplicate
 * automatically. tmux/screen exhibit the same property for the same reason.
 */
function normalizeForVisibleEquivalence(s: string): string {
  return s.replace(/\r+/g, "\r");
}

describeIfReady("§4.2 acceptance: limbo vs bare claude", () => {
  it("--help renders identically to bare claude (visible-equivalent) with same exit code", async () => {
    const bare = await runUnderPty(claudeBin as string, ["--help"]);
    const wrapped = await runUnderPty(process.execPath, [CLI, "--help"]);

    expect(wrapped.exitCode).toBe(bare.exitCode);
    expect(normalizeForVisibleEquivalence(wrapped.output)).toBe(
      normalizeForVisibleEquivalence(bare.output),
    );
  });

  it("propagates a non-zero exit code from claude through limbo", async () => {
    const bare = await runUnderPty(claudeBin as string, ["--this-flag-does-not-exist"]);
    const wrapped = await runUnderPty(process.execPath, [CLI, "--this-flag-does-not-exist"]);

    expect(bare.exitCode).not.toBe(0);
    expect(wrapped.exitCode).toBe(bare.exitCode);
  });
});
