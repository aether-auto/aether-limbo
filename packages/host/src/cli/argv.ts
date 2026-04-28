/**
 * Minimal argv parser for the `limbo` CLI.
 *
 * Returns a tagged union so cli.ts can dispatch without string-matching everywhere.
 * Intentionally no third-party parser — stdlib only.
 */

export type ParsedArgv =
  | { kind: "version" }
  | { kind: "config-edit" }
  | { kind: "config-show" }
  | { kind: "config-unknown"; sub: string }
  | { kind: "config-missing-sub" }
  | { kind: "wrap"; argv: readonly string[] };

/**
 * Parse process.argv.slice(2) into a tagged union.
 *
 * Rules:
 *  - `--version` / `-v` alone  → { kind: "version" }
 *  - `config edit`             → { kind: "config-edit" }
 *  - `config show`             → { kind: "config-show" }
 *  - `config <other>`          → { kind: "config-unknown", sub }
 *  - `config` (no sub)         → { kind: "config-missing-sub" }
 *  - anything else             → { kind: "wrap", argv }
 */
export function parseArgv(argv: readonly string[]): ParsedArgv {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    return { kind: "version" };
  }

  if (argv.length >= 1 && argv[0] === "config") {
    const sub = argv[1];
    if (sub === undefined) return { kind: "config-missing-sub" };
    if (sub === "edit") return { kind: "config-edit" };
    if (sub === "show") return { kind: "config-show" };
    return { kind: "config-unknown", sub };
  }

  return { kind: "wrap", argv };
}

export function configUsage(): string {
  return [
    "Usage: limbo config <subcommand>",
    "",
    "Subcommands:",
    "  edit   Open the config file in $VISUAL / $EDITOR / nano / vi",
    "  show   Print current config (TOML format) to stdout",
  ].join("\n");
}
