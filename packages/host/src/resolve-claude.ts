import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

const CLAUDE_BIN_NAME = "claude";

export class ClaudeNotFoundError extends Error {
  readonly searched: readonly string[];
  readonly overrideAttempted: string | undefined;

  constructor(searched: readonly string[], opts?: { overrideAttempted?: string }) {
    super(formatMessage(searched, opts?.overrideAttempted));
    this.name = "ClaudeNotFoundError";
    this.searched = searched;
    this.overrideAttempted = opts?.overrideAttempted;
  }
}

function formatMessage(searched: readonly string[], overrideAttempted: string | undefined): string {
  if (overrideAttempted !== undefined) {
    return [
      `limbo: $CLAUDE_BIN is set to "${overrideAttempted}" but it is not an executable file.`,
      "Unset $CLAUDE_BIN or point it at a real claude binary.",
    ].join("\n");
  }
  const count = searched.length;
  const plural = count === 1 ? "" : "s";
  return [
    "limbo: could not find 'claude' on $PATH.",
    `Searched ${count} location${plural}.`,
    "Install Claude Code first (https://docs.claude.com/claude-code), or set CLAUDE_BIN to an explicit path.",
  ].join("\n");
}

/** Internal helper — exported for tests. */
export function isExecutableFile(path: string): boolean {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return false;
  return (st.mode & 0o111) !== 0;
}

interface PathSearchResult {
  found: string | null;
  searched: string[];
}

function findOnPath(binary: string, pathEnv: string | undefined): PathSearchResult {
  const searched: string[] = [];
  if (!pathEnv) return { found: null, searched };
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    searched.push(candidate);
    if (isExecutableFile(candidate)) return { found: candidate, searched };
  }
  return { found: null, searched };
}

/**
 * Locate the `claude` executable that limbo will wrap.
 *
 * Resolution order:
 *   1. `$CLAUDE_BIN` if set — used directly, but stat-validated. A misconfigured
 *      override fails fast with a clear error rather than producing a confusing
 *      PTY spawn failure later.
 *   2. Walk `$PATH` left-to-right and return the first executable named `claude`.
 *
 * The returned path is intentionally *not* realpath'd: if the user's shell
 * sees a symlink (e.g. `/opt/homebrew/bin/claude`), so should limbo. That keeps
 * `which claude` and limbo's resolution in agreement, which matters when
 * debugging "why is limbo wrapping the wrong version".
 *
 * @throws {ClaudeNotFoundError} if neither path yields an executable.
 */
export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_BIN;
  if (override !== undefined && override.length > 0) {
    if (isExecutableFile(override)) return override;
    throw new ClaudeNotFoundError([override], { overrideAttempted: override });
  }
  const { found, searched } = findOnPath(CLAUDE_BIN_NAME, env.PATH);
  if (found) return found;
  throw new ClaudeNotFoundError(searched);
}
