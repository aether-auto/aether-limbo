/**
 * `limbo config edit` — resolve editor and spawn it.
 *
 * Editor resolution chain: $VISUAL → $EDITOR → nano → vi
 *
 * All I/O is injectable for testability.
 */

import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";

// ---------------------------------------------------------------------------
// Injectable interfaces
// ---------------------------------------------------------------------------

export type SpawnSyncFn = (
  cmd: string,
  args: string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer | string>;

export interface ConfigEditFsCheck {
  /** Returns true if the file exists. */
  exists(path: string): boolean;
}

export interface ConfigEditDeps {
  readonly configPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly spawnSync: SpawnSyncFn;
  readonly fs: ConfigEditFsCheck;
  readonly stderr: { write(s: string): void };
  /** Called to ensure config file exists before opening editor (writes defaults). */
  readonly ensureConfig: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Editor resolution
// ---------------------------------------------------------------------------

const FALLBACK_EDITORS = ["nano", "vi"] as const;

/**
 * Resolve the editor binary.
 *
 * Precedence: $VISUAL → $EDITOR → nano → vi
 */
export function resolveEditor(env: NodeJS.ProcessEnv): string {
  if (env.VISUAL) return env.VISUAL;
  if (env.EDITOR) return env.EDITOR;
  return FALLBACK_EDITORS[0]; // "nano" — then vi is the last resort below
}

/**
 * Spawn the editor for the config file.
 *
 * 1. If config file is missing, call `ensureConfig()` first (writes defaults).
 * 2. Try $VISUAL → $EDITOR → nano → vi in order.
 * 3. Return the editor's exit code (or 1 on spawn failure).
 */
export async function runConfigEdit(deps: ConfigEditDeps): Promise<number> {
  // Ensure config file exists (write defaults / run wizard).
  if (!deps.fs.exists(deps.configPath)) {
    await deps.ensureConfig();
  }

  // Build ordered list of editors to try.
  const editorChain: string[] = [];
  if (deps.env.VISUAL) editorChain.push(deps.env.VISUAL);
  if (deps.env.EDITOR && deps.env.EDITOR !== deps.env.VISUAL) {
    editorChain.push(deps.env.EDITOR);
  }
  for (const fallback of FALLBACK_EDITORS) {
    if (!editorChain.includes(fallback)) editorChain.push(fallback);
  }

  let lastError: string | undefined;
  for (const editor of editorChain) {
    const result = deps.spawnSync(editor, [deps.configPath], { stdio: "inherit" });

    if (result.error) {
      // Spawn failed (ENOENT = binary not found) — try next.
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        lastError = `editor not found: ${editor}`;
        continue;
      }
      deps.stderr.write(`limbo: editor error (${editor}): ${result.error.message}\n`);
      return 1;
    }

    return result.status ?? 0;
  }

  deps.stderr.write(
    `limbo: could not find an editor. Set $VISUAL or $EDITOR, or install nano/vi.\n${lastError ? `  (last error: ${lastError})\n` : ""}`,
  );
  return 1;
}
