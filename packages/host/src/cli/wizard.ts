/**
 * First-run wizard and default-config writer.
 *
 * Two paths:
 *   runWizard({ tty: true, ... })  → interactive readline prompts, writes config
 *   runWizard({ tty: false, ... }) → silent default-write, prints notice to stderr
 *
 * All I/O and fs interactions are injectable for testability.
 */

import { createInterface } from "node:readline";
import type { Interface as RlInterface } from "node:readline";
import { CONFIG_TEMPLATE } from "../config/template.js";

// ---------------------------------------------------------------------------
// Injectable interfaces
// ---------------------------------------------------------------------------

export interface WizardFsWriter {
  mkdir(path: string, opts: { recursive: boolean; mode: number }): Promise<unknown>;
  writeFile(path: string, data: string): Promise<void>;
}

export interface WizardStdin extends NodeJS.EventEmitter {
  readonly isTTY?: boolean;
}

export interface WizardStdout {
  write(s: string): void;
}

export interface WizardStderr {
  write(s: string): void;
}

export interface WizardRlFactory {
  createInterface(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): RlInterface;
}

export interface WizardDeps {
  /** Absolute path where config file should be written. */
  readonly configPath: string;
  /** Parent directory of configPath; will be mkdir -p'd at 0700. */
  readonly configDir: string;
  readonly isTTY: boolean;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: WizardStdout;
  readonly stderr: WizardStderr;
  readonly fs: WizardFsWriter;
  readonly rl?: WizardRlFactory;
}

// ---------------------------------------------------------------------------
// Chord prompt helpers
// ---------------------------------------------------------------------------

/** Normalize a human-readable chord string like "ctrl+l" to a byte string. */
function parseChordInput(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return null; // blank → keep default

  // ctrl+<letter>
  const ctrlMatch = /^ctrl\+([a-z])$/.exec(trimmed);
  if (ctrlMatch) {
    const letter = ctrlMatch[1] ?? "";
    const byte = letter.charCodeAt(0) - 0x60; // 'a' → 1, 'l' → 12
    return String.fromCharCode(byte);
  }

  // Allow raw escape sequences (F-key names, etc.) through as-is — advanced users.
  return trimmed;
}

/** Build a TOML unicode escape for a single-byte chord. */
function chordToToml(chord: string): string {
  // Encode each character as \uXXXX if it's a control char or non-ASCII.
  return chord
    .split("")
    .map((c) => {
      const code = c.charCodeAt(0);
      if (code < 0x20 || code >= 0x7f) {
        return `\\u${code.toString(16).padStart(4, "0")}`;
      }
      return c;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function question(rl: RlInterface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function yesNo(rl: RlInterface, prompt: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await question(rl, `${prompt} ${hint} `);
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "") return defaultYes;
  return trimmed === "y" || trimmed === "yes";
}

// ---------------------------------------------------------------------------
// Config template substitution
// ---------------------------------------------------------------------------

interface WizardChoices {
  chord: string; // Already-decoded byte string for the chord
  enabled: {
    reels: boolean;
    feed: boolean;
    dms: boolean;
    x: boolean;
    tiktok: boolean;
  };
}

/** Build a filled-in config template from the wizard choices. */
function buildConfigToml(choices: WizardChoices): string {
  const chordToml = chordToToml(choices.chord);

  const { reels, feed, dms, x, tiktok } = choices.enabled;
  // Build tab_order from enabled tabs only.
  const allTabs: Array<[string, boolean]> = [
    ["reels", reels],
    ["feed", feed],
    ["dms", dms],
    ["x", x],
    ["tiktok", tiktok],
  ];
  const tabOrder = allTabs.filter(([, en]) => en).map(([id]) => id);
  const tabOrderToml = `[${tabOrder.map((t) => `"${t}"`).join(", ")}]`;

  // Replace specific lines in the template.
  let out = CONFIG_TEMPLATE;
  out = out.replace(/^chord = ".*"$/m, `chord = "${chordToml}"`);
  out = out.replace(/^tab_order = \[.*\]$/m, `tab_order = ${tabOrderToml}`);
  out = out.replace(/^reels {2}= (true|false)$/m, `reels  = ${reels}`);
  out = out.replace(/^feed {3}= (true|false)$/m, `feed   = ${feed}`);
  out = out.replace(/^dms {4}= (true|false)$/m, `dms    = ${dms}`);
  out = out.replace(/^x {6}= (true|false)$/m, `x      = ${x}`);
  out = out.replace(/^tiktok = (true|false)$/m, `tiktok = ${tiktok}`);
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the first-run wizard or silent default-write.
 *
 * When `isTTY` is true: prompt the user interactively and write their choices.
 * When `isTTY` is false: silently write CONFIG_TEMPLATE verbatim, print notice to stderr.
 *
 * Returns when the config file has been written.
 */
export async function runWizard(deps: WizardDeps): Promise<void> {
  await deps.fs.mkdir(deps.configDir, { recursive: true, mode: 0o700 });

  if (!deps.isTTY) {
    await deps.fs.writeFile(deps.configPath, CONFIG_TEMPLATE);
    deps.stderr.write(
      `limbo: wrote default config to ${deps.configPath} — edit with \`limbo config edit\`\n`,
    );
    return;
  }

  // Interactive path.
  const rlFactory = deps.rl ?? {
    createInterface: (stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream) =>
      createInterface({ input: stdin, output: stdout }),
  };
  const rl = rlFactory.createInterface(
    deps.stdin as NodeJS.ReadableStream,
    deps.stdout as unknown as NodeJS.WritableStream,
  );

  deps.stdout.write("\naether-limbo first-run setup (press Enter to accept defaults)\n\n");

  // Prompt 1: hotkey chord.
  const chordRaw = await question(rl, "Hotkey chord? (default: Ctrl+L): ");
  const parsedChord = parseChordInput(chordRaw);
  const chord = parsedChord ?? "\x0c"; // default: Ctrl+L

  deps.stdout.write("\nWhich tabs would you like to enable?\n");

  // Prompt 2-6: per-tab enabled flags.
  const reels = await yesNo(rl, "  Enable Reels?");
  const feed = await yesNo(rl, "  Enable Feed?");
  const dms = await yesNo(rl, "  Enable DMs?");
  const x = await yesNo(rl, "  Enable X (Twitter)?");
  const tiktok = await yesNo(rl, "  Enable TikTok?");

  rl.close();

  const content = buildConfigToml({ chord, enabled: { reels, feed, dms, x, tiktok } });
  await deps.fs.writeFile(deps.configPath, content);
  deps.stdout.write(`\nConfig written to ${deps.configPath}\n`);
}
