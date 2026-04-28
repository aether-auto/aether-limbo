import { EventEmitter } from "node:events";
import type { Interface as RlInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import { runWizard } from "./wizard.js";
import type { WizardDeps, WizardFsWriter, WizardRlFactory } from "./wizard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeFs(): WizardFsWriter & { written: Map<string, string>; dirs: string[] } {
  const written = new Map<string, string>();
  const dirs: string[] = [];
  return {
    written,
    dirs,
    mkdir: async (path: string) => {
      dirs.push(path);
    },
    writeFile: async (path: string, data: string) => {
      written.set(path, data);
    },
  };
}

function makeFakeStdout(): { write: (s: string) => void; output: string[] } {
  const output: string[] = [];
  return { write: (s) => output.push(s), output };
}

function makeFakeStderr(): { write: (s: string) => void; output: string[] } {
  const output: string[] = [];
  return { write: (s) => output.push(s), output };
}

// Build a fake readline factory that feeds `answers` in order.
function makeRlFactory(answers: string[]): WizardRlFactory {
  let idx = 0;
  return {
    createInterface: (_stdin, _stdout): RlInterface => {
      const ee = new EventEmitter();
      const rl = Object.assign(ee, {
        question: (_prompt: string, cb: (answer: string) => void) => {
          const answer = answers[idx++] ?? "";
          // Defer to next microtask so we don't call cb synchronously inside question().
          void Promise.resolve().then(() => cb(answer));
        },
        close: vi.fn(),
      }) as unknown as RlInterface;
      return rl;
    },
  };
}

function baseDeps(overrides: Partial<WizardDeps> = {}): WizardDeps {
  return {
    configPath: "/home/user/.config/aether-limbo/config.toml",
    configDir: "/home/user/.config/aether-limbo",
    isTTY: false,
    stdin: new EventEmitter() as NodeJS.ReadableStream,
    stdout: makeFakeStdout(),
    stderr: makeFakeStderr(),
    fs: makeFakeFs(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Non-TTY (silent) path
// ---------------------------------------------------------------------------

describe("runWizard — non-TTY", () => {
  it("writes CONFIG_TEMPLATE verbatim to configPath", async () => {
    const fs = makeFakeFs();
    await runWizard(baseDeps({ fs }));
    expect(fs.written.has("/home/user/.config/aether-limbo/config.toml")).toBe(true);
    const content = fs.written.get("/home/user/.config/aether-limbo/config.toml") ?? "";
    // Should contain key TOML sections from the template.
    expect(content).toContain("[hotkey]");
    expect(content).toContain("[guard]");
    expect(content).toContain("[snapback]");
    expect(content).toContain("[adapters]");
  });

  it("creates parent dir with mode 0700", async () => {
    const fs = makeFakeFs();
    const mkdirSpy = vi.spyOn(fs, "mkdir");
    await runWizard(baseDeps({ fs }));
    expect(mkdirSpy).toHaveBeenCalledWith(
      "/home/user/.config/aether-limbo",
      expect.objectContaining({ recursive: true, mode: 0o700 }),
    );
  });

  it("prints notice to stderr", async () => {
    const stderr = makeFakeStderr();
    await runWizard(baseDeps({ stderr }));
    expect(stderr.output.join("")).toContain("wrote default config to");
    expect(stderr.output.join("")).toContain("limbo config edit");
  });

  it("does not write to stdout on non-TTY path", async () => {
    const stdout = makeFakeStdout();
    await runWizard(baseDeps({ stdout }));
    expect(stdout.output.join("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Interactive (TTY) path
// ---------------------------------------------------------------------------

describe("runWizard — TTY interactive", () => {
  it("accepts Enter for defaults: Ctrl+L chord, all tabs enabled", async () => {
    const fs = makeFakeFs();
    // All blank answers → accept all defaults.
    const rl = makeRlFactory(["", "", "", "", "", ""]);
    await runWizard(
      baseDeps({
        isTTY: true,
        fs,
        rl,
      }),
    );
    const content = fs.written.get("/home/user/.config/aether-limbo/config.toml") ?? "";
    // Default chord = Ctrl+L =
    expect(content).toContain('chord = "\\u000c"');
    // All tabs still enabled.
    expect(content).toContain("reels  = true");
    expect(content).toContain("tiktok = true");
  });

  it("parses ctrl+<letter> chord input", async () => {
    const fs = makeFakeFs();
    // chord=ctrl+j, then all defaults for tabs.
    const rl = makeRlFactory(["ctrl+j", "", "", "", "", ""]);
    await runWizard(baseDeps({ isTTY: true, fs, rl }));
    const content = fs.written.get("/home/user/.config/aether-limbo/config.toml") ?? "";
    // ctrl+j = \x0a =

    expect(content).toContain('chord = "\\u000a"');
  });

  it("disabling a tab removes it from tab_order and sets enabled=false", async () => {
    const fs = makeFakeFs();
    // chord blank, reels=Y, feed=Y, dms=n (disabled), x=Y, tiktok=Y
    const rl = makeRlFactory(["", "", "", "n", "", ""]);
    await runWizard(baseDeps({ isTTY: true, fs, rl }));
    const content = fs.written.get("/home/user/.config/aether-limbo/config.toml") ?? "";
    expect(content).toContain("dms    = false");
    // dms should be absent from tab_order
    const tabOrderMatch = /tab_order = \[([^\]]*)\]/.exec(content);
    const tabOrder = tabOrderMatch?.[1] ?? "";
    expect(tabOrder).not.toContain("dms");
  });

  it("writes config file and prints a completion message to stdout", async () => {
    const fs = makeFakeFs();
    const stdout = makeFakeStdout();
    const rl = makeRlFactory(["", "", "", "", "", ""]);
    await runWizard(baseDeps({ isTTY: true, fs, rl, stdout }));
    expect(stdout.output.join("")).toContain("Config written to");
  });
});
