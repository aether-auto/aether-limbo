import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "@iarna/toml";
import { configUsage, parseArgv } from "./cli/argv.js";
import { runConfigEdit } from "./cli/config-edit.js";
import { runWizard } from "./cli/wizard.js";
import type { DEFAULT_CONFIG } from "./config/defaults.js";
import { loadConfig } from "./config/loader.js";
import { getConfigDir, getConfigPath, getDataDir, getSecretsPath } from "./config/paths.js";
import { loadSecrets } from "./config/secrets.js";
import { VERSION } from "./index.js";
import { DEFAULT_TABS } from "./overlay/types.js";
import { defaultPtyFactory } from "./pty/spawn.js";
import { ClaudeNotFoundError, resolveClaudeBin } from "./resolve-claude.js";
import { TerminalGuard } from "./terminal/terminal-guard.js";
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
  const home = process.env.HOME ?? homedir();
  const configPath = getConfigPath(process.env, home);
  const configDir = getConfigDir(process.env, home);
  const secretsPath = getSecretsPath(process.env, home);

  const parsed = parseArgv(argv);

  // -------------------------------------------------------------------------
  // `limbo config` subcommands — handled before resolving claudeBin
  // -------------------------------------------------------------------------

  if (parsed.kind === "config-missing-sub" || parsed.kind === "config-unknown") {
    process.stderr.write(`${configUsage()}\n`);
    if (parsed.kind === "config-unknown") {
      process.stderr.write(`limbo: unknown config subcommand: ${parsed.sub}\n`);
    }
    process.exit(2);
  }

  if (parsed.kind === "config-show") {
    const { config } = await loadConfig({ path: configPath });
    // Reconstruct a TOML-serialisable plain object from config.
    const obj = configToTomlObject(config);
    process.stdout.write(
      existsSync(configPath)
        ? stringify(obj as Parameters<typeof stringify>[0])
        : `# no config file at ${configPath}; showing defaults\n${stringify(obj as Parameters<typeof stringify>[0])}`,
    );
    process.exit(0);
  }

  if (parsed.kind === "config-edit") {
    const exitCode = await runConfigEdit({
      configPath,
      env: process.env,
      spawnSync,
      fs: { exists: existsSync },
      stderr: process.stderr,
      ensureConfig: () =>
        runWizard({
          configPath,
          configDir,
          isTTY: false, // write defaults silently; user is about to open editor
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          fs: { mkdir, writeFile },
        }),
    });
    process.exit(exitCode);
  }

  // -------------------------------------------------------------------------
  // Regular passthrough — resolve claudeBin, load config, run wizard if needed
  // -------------------------------------------------------------------------

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

  if (parsed.kind === "version") {
    printVersion(claudeBin);
    return;
  }

  // Load config — run wizard if file is missing.
  const { config, loadedFrom } = await loadConfig({ path: configPath });
  if (loadedFrom === null) {
    // In the regular passthrough path the wizard always uses the silent (non-interactive)
    // mode regardless of TTY.  Interactive prompts would block the PTY while the wrapped
    // process is also waiting for input, leading to a deadlock-like hang.  Users who want
    // to customise interactively should run `limbo config edit`.
    await runWizard({
      configPath,
      configDir,
      isTTY: false,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      fs: { mkdir, writeFile },
    });
  }

  // Load secrets (insecure-perms warning already emitted by loadSecrets).
  const { secrets } = await loadSecrets({
    path: secretsPath,
    logger: { warn: (msg) => process.stderr.write(`${msg}\n`) },
  });

  // Build per-adapter env overrides from config.
  const adapterEnv = buildAdapterEnv(config);

  // Build filtered tab list from config.adapters.tabOrder + config.adapters.enabled.
  const tabs = buildTabs(config);

  // Build escalation option.
  const escalation =
    config.guard.idleAttemptsBeforeEscalation > 0 && config.guard.escalationMessages.length > 0
      ? {
          threshold: config.guard.idleAttemptsBeforeEscalation,
          messages: config.guard.escalationMessages,
        }
      : undefined;

  // Resolve the sidecar package path relative to this module's directory.
  // In production: dist/cli.js → ../../sidecars (monorepo layout).
  // In test/dev: src/cli.ts → ../../../sidecars (same relative depth).
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  // dist/cli.js is two levels below packages/host; sidecars is a sibling of host.
  const packagePath = path.resolve(thisDir, "..", "..", "..", "sidecars");
  const venvDir = path.join(getDataDir(process.env, home), "venv");
  const pythonExe = process.env.LIMBO_PYTHON_EXE ?? "python3";

  const guard = new TerminalGuard({
    stdin: process.stdin,
    process,
    exit: (code) => process.exit(code),
  });
  guard.enter();
  try {
    const exitCode = await runWrapper({
      claudeBin,
      argv: parsed.argv,
      env: process.env,
      cwd: process.cwd(),
      stdin: process.stdin,
      stdout: process.stdout,
      process,
      ptyFactory: defaultPtyFactory,
      chord: config.hotkey.chord,
      shameMessage: config.guard.message,
      shameHoldMs: config.guard.holdMs,
      ...(escalation !== undefined ? { escalation } : {}),
      secrets,
      tabs,
      snapBackEnabled: config.snapback.enabled,
      adapterEnv,
      globalKeepWarm: config.adapters.keepWarm,
      tiktokKeepWarm: config.adapters.tiktok.keepWarm,
      venvDir,
      pythonExe,
      packagePath,
    });
    guard.restore();
    process.exit(exitCode);
  } finally {
    guard.restore();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert LimboConfig back to a plain object suitable for @iarna/toml stringify.
 * (stringify requires Record<string, unknown> at the top level.)
 */
function configToTomlObject(config: typeof DEFAULT_CONFIG): Record<string, unknown> {
  return {
    hotkey: { chord: config.hotkey.chord },
    guard: {
      message: config.guard.message,
      hold_ms: config.guard.holdMs,
      idle_attempts_before_escalation: config.guard.idleAttemptsBeforeEscalation,
      escalation_messages: [...config.guard.escalationMessages],
    },
    snapback: { enabled: config.snapback.enabled },
    adapters: {
      tab_order: [...config.adapters.tabOrder],
      keep_warm: config.adapters.keepWarm,
      enabled: { ...config.adapters.enabled },
      instagram: {
        thumbnails: config.adapters.instagram.thumbnails,
        thumbnail_max_rows: config.adapters.instagram.thumbnailMaxRows,
      },
      twitter: {
        auth: config.adapters.twitter.auth,
        cache_dms: config.adapters.twitter.cacheDms,
        language: config.adapters.twitter.language,
      },
      tiktok: {
        refresh_on_failure: config.adapters.tiktok.refreshOnFailure,
        keep_warm: config.adapters.tiktok.keepWarm,
      },
    },
  };
}

/**
 * Build a filtered, ordered list of tabs from config.
 *
 * Uses DEFAULT_TABS as the lookup source for label/adapterId.
 * Filters out tabs that are disabled in config.adapters.enabled.
 * Orders according to config.adapters.tabOrder.
 */
function buildTabs(config: typeof DEFAULT_CONFIG) {
  // Map tab id → TabDefinition for the known built-in tabs.
  const tabById = new Map(DEFAULT_TABS.map((t) => [t.id, t]));

  return config.adapters.tabOrder
    .filter((id) => {
      const enabled = config.adapters.enabled[id];
      return enabled !== false; // treat missing as enabled
    })
    .flatMap((id) => {
      const tab = tabById.get(id as (typeof DEFAULT_TABS)[number]["id"]);
      return tab !== undefined ? [tab] : [];
    });
}

/**
 * Build per-adapter env-var override maps from config.
 *
 * Keys are adapter ids; values are env maps merged into sidecar env.
 */
function buildAdapterEnv(config: typeof DEFAULT_CONFIG): Record<string, Record<string, string>> {
  const env: Record<string, Record<string, string>> = {};

  // Twitter env vars.
  const twEnv: Record<string, string> = {};
  if (config.adapters.twitter.cacheDms) twEnv.LIMBO_TWITTER_CACHE_DMS = "1";
  twEnv.LIMBO_TWITTER_BACKEND = config.adapters.twitter.auth;
  if (Object.keys(twEnv).length > 0) env["twitter-home"] = twEnv;

  // TikTok env vars.
  const ttEnv: Record<string, string> = {};
  if (config.adapters.tiktok.refreshOnFailure) ttEnv.LIMBO_TIKTOK_REFRESH_ON_FAILURE = "1";
  if (Object.keys(ttEnv).length > 0) env["tiktok-foryou"] = ttEnv;

  // Instagram env vars (thumbnails config — Phase 9 plumbing).
  const igEnv: Record<string, string> = {
    LIMBO_IG_THUMBNAILS: config.adapters.instagram.thumbnails ? "1" : "0",
    LIMBO_IG_THUMBNAIL_MAX_ROWS: String(config.adapters.instagram.thumbnailMaxRows),
  };
  env["instagram-reels"] = igEnv;
  env["instagram-feed"] = igEnv;
  env["instagram-dms"] = igEnv;

  return env;
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`limbo: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
