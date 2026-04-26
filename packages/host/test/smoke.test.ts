import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as ptySpawn } from "node-pty";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "fixtures");
const CLI = resolve(HERE, "..", "dist", "cli.js");

const skipReason = existsSync(CLI)
  ? null
  : `dist/cli.js not built — run 'pnpm --filter @aether/limbo-host build' first`;
const describeIfBuilt = skipReason ? describe.skip : describe;
if (skipReason) console.warn(`[smoke] skipping: ${skipReason}`);

interface SpawnedLimbo {
  pid: number;
  onData: (cb: (s: string) => void) => void;
  onExit: () => Promise<{ exitCode: number; signal?: number }>;
  write: (s: string) => void;
  kill: (sig?: string) => void;
}

function spawnLimbo(claudeBin: string, args: string[] = []): SpawnedLimbo {
  const child = ptySpawn(process.execPath, [CLI, ...args], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: HERE,
    env: { ...process.env, CLAUDE_BIN: claudeBin } as Record<string, string>,
  });
  return {
    pid: child.pid,
    onData: (cb) => {
      child.onData(cb);
    },
    onExit: () =>
      new Promise((res) => {
        child.onExit((e) => res(e));
      }),
    write: (s) => child.write(s),
    kill: (sig) => child.kill(sig),
  };
}

describeIfBuilt("limbo cli end-to-end through real PTY", () => {
  it("propagates the wrapped binary's exit code", async () => {
    const limbo = spawnLimbo(`${FIXTURES}/exit-code.sh`, ["7"]);
    const exit = await limbo.onExit();
    expect(exit.exitCode).toBe(7);
  });

  it("proxies bytes both ways: stdin → child, child → stdout", async () => {
    const limbo = spawnLimbo(`${FIXTURES}/echo-line.sh`);
    let out = "";
    limbo.onData((d) => {
      out += d;
    });
    limbo.write("ping\r");
    await limbo.onExit();
    expect(out).toContain("ping");
  });

  it("forwards SIGTERM to the wrapped child", async () => {
    const limbo = spawnLimbo(`${FIXTURES}/wait.sh`);
    let out = "";
    limbo.onData((d) => {
      out += d;
    });
    setTimeout(() => limbo.kill("SIGTERM"), 250);
    await limbo.onExit();
    expect(out).toContain("CAUGHT_TERM");
  });
});
