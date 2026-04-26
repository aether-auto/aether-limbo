import { spawnSync } from "node:child_process";
import { VERSION } from "./index.js";
import { ClaudeNotFoundError, resolveClaudeBin } from "./resolve-claude.js";

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

function main(argv: string[]): void {
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

  if (argv.includes("--version") || argv.includes("-v")) {
    printVersion(claudeBin);
    return;
  }

  // TODO(§4.2): replace this stub with the real PTY wrapper.
  process.stderr.write(
    `limbo ${VERSION}: PTY wrapper not implemented yet. ` + `Resolved claude at: ${claudeBin}\n`,
  );
  process.exit(0);
}

main(process.argv.slice(2));
