import { spawnSync } from "node:child_process";
import { cwd } from "node:process";
import { defaultPtyFactory } from "./pty/spawn.js";
import { ClaudeNotFoundError, resolveClaudeBin } from "./resolve-claude.js";
import { TerminalGuard } from "./terminal/terminal-guard.js";
import { VERSION } from "./index.js";
import { runWrapper } from "./wrapper.js";

function printVersion(claudeBin: string): void {
  process.stdout.write(`limbo ${VERSION}\n`);
  const result = spawnSync(claudeBin, ["--version"], { encoding: "utf8" });
  if (result.status === 0) {
    process.stdout.write(`wraps: ${result.stdout.trim()}\n`);
  } else {
    process.stderr.write("limbo: failed to invoke claude --version\n");
    process.exit(result.status ?? 1);
  }
}

async function main(argv: string[]): Promise<void> {
  let claudeBin: string;
  try {
    claudeBin = resolveClaudeBin();
  } catch (err) {
    if (err instanceof ClaudeNotFoundError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(127);
    }
    throw err;
  }

  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    printVersion(claudeBin);
    return;
  }

  const guard = new TerminalGuard({
    stdin: process.stdin,
    process,
    exit: (code) => process.exit(code),
  });
  guard.enter();
  try {
    const exitCode = await runWrapper({
      claudeBin,
      argv,
      env: process.env,
      cwd: cwd(),
      stdin: process.stdin,
      stdout: process.stdout,
      process,
      ptyFactory: defaultPtyFactory,
    });
    guard.restore();
    process.exit(exitCode);
  } finally {
    guard.restore();
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`limbo: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
