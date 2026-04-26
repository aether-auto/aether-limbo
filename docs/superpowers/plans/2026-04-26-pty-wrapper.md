# PTY Wrapper Implementation Plan (PLAN.md §4.2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `limbo <args>` indistinguishable from `claude <args>` by spawning the resolved `claude` binary inside a pseudo-terminal and proxying every byte, signal, and resize event in both directions.

**Architecture:** A small set of single-responsibility modules under `packages/host/src/`: a pure exit-code translator, a `TerminalGuard` that owns raw-mode lifecycle, an `IPty` interface that lets us mock `node-pty` in unit tests, and a `runWrapper` orchestrator that wires everything. `cli.ts` becomes a thin entrypoint. One end-to-end smoke test exercises the real built binary against shell-script fixtures via real `node-pty`.

**Tech Stack:** Node ≥ 20, TypeScript strict ESM, `node-pty` ^1.0.0, `vitest` for tests, `tsup` for the build, fixture shell scripts under `packages/host/test/fixtures/`.

**Decisions confirmed with user (2026-04-26):**
- Exit code: POSIX `128 + signum` when child dies by signal; numeric code otherwise.
- Test strategy: unit tests with mocked `IPty`, plus one end-to-end smoke test against the built `dist/cli.js`.
- Cleanup: dedicated `TerminalGuard` class, wired via `try/finally` and `process.on('uncaughtException' | 'SIGINT' | …)`.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `packages/host/src/pty/types.ts` | `IPty` (subset of node-pty surface), `PtyExit`, `IDisposable`. The interface tests mock against. |
| `packages/host/src/pty/exit-code.ts` | Pure `translateExit({exitCode, signal})` → `number`. |
| `packages/host/src/pty/exit-code.test.ts` | Pure-function tests for exit-code translation. |
| `packages/host/src/pty/spawn.ts` | `spawnClaudePty(opts)` factory; default delegates to `node-pty`, accepts injection. |
| `packages/host/src/terminal/terminal-guard.ts` | `TerminalGuard` — owns raw-mode + signal handlers + restore-on-anything. |
| `packages/host/src/terminal/terminal-guard.test.ts` | Tests with a fake stdin and stub `process` event surface. |
| `packages/host/src/wrapper.ts` | `runWrapper(opts)` — bidirectional pipe + signal/resize forwarding + exit waiting. |
| `packages/host/src/wrapper.test.ts` | Wires a `MockPty` + fake stdin/stdout and asserts byte-level transparency. |
| `packages/host/src/cli.ts` | Thin entrypoint: resolve claude, build guard, call `runWrapper`, propagate exit code. |
| `packages/host/src/index.ts` | Re-export new public surface (`runWrapper`, `TerminalGuard`, `translateExit`). |
| `packages/host/test/fixtures/echo-line.sh` | Reads one line from stdin, prints it back, exits 0. |
| `packages/host/test/fixtures/exit-code.sh` | Exits with the integer in `$1`. |
| `packages/host/test/fixtures/sigwinch.sh` | Traps `SIGWINCH`, prints `WINCH ${LINES}x${COLUMNS}`, sleeps. |
| `packages/host/test/fixtures/wait.sh` | Sleeps 60s — used to test signal forwarding kills the child. |
| `packages/host/test/smoke.test.ts` | One end-to-end smoke test: spawns `node dist/cli.js` with `CLAUDE_BIN` pointed at fixtures, drives a real PTY. |
| `packages/host/package.json` | Adds `node-pty` dep + `pretest` builds dist. |
| `README.md` | Status table updated; PTY wrapper marked done. |

---

## Task 1: Add `node-pty` and `IPty` interface

**Files:**
- Modify: `packages/host/package.json`
- Create: `packages/host/src/pty/types.ts`

- [ ] **Step 1: Add `node-pty` to host deps and a `pretest` build hook**

Edit `packages/host/package.json` to add `node-pty` to `dependencies` and update `scripts.test` to build first so the smoke test has a `dist/` to spawn.

```json
{
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "test": "tsup && vitest run",
    "test:watch": "vitest",
    "smoke": "node dist/cli.js --version"
  },
  "dependencies": {
    "node-pty": "^1.0.0"
  }
}
```

- [ ] **Step 2: Install**

```bash
pnpm install
```

Expected: `node-pty` resolves and the `prebuild` step in node-pty compiles native bindings (or fetches a prebuilt). On Apple Silicon you should see `Successfully built ...` or a prebuilt download.

- [ ] **Step 3: Define the `IPty` interface limbo depends on**

Create `packages/host/src/pty/types.ts`:

```typescript
/**
 * Subset of node-pty's IPty surface that limbo actually uses.
 *
 * Defined locally so unit tests can supply a mock without pulling node-pty into
 * the test process (node-pty has native bindings + a real subprocess; both are
 * unwanted complexity in pure unit tests).
 */
export interface IDisposable {
  dispose(): void;
}

export interface PtyExit {
  /** Numeric exit code. 0 if the child died by signal. */
  readonly exitCode: number;
  /**
   * Signal number that killed the child, if any. node-pty exposes this as a
   * raw int (POSIX signum), not a name. `undefined` for normal exit.
   */
  readonly signal?: number;
}

export interface IPty {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (event: PtyExit) => void): IDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
}

export type PtyFactory = (opts: PtySpawnOptions) => IPty;
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @aether/limbo-host run typecheck
```

Expected: clean. No tests written for this module — it's pure types.

- [ ] **Step 5: Commit**

```bash
git add packages/host/package.json packages/host/src/pty/types.ts pnpm-lock.yaml
git commit -m "feat(host): add node-pty dep and IPty interface for §4.2"
```

---

## Task 2: Pure exit-code translator (TDD)

**Files:**
- Create: `packages/host/src/pty/exit-code.test.ts`
- Create: `packages/host/src/pty/exit-code.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/host/src/pty/exit-code.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { translateExit } from "./exit-code.js";

describe("translateExit", () => {
  it("returns the exitCode unchanged when the child exited normally", () => {
    expect(translateExit({ exitCode: 0 })).toBe(0);
    expect(translateExit({ exitCode: 1 })).toBe(1);
    expect(translateExit({ exitCode: 42 })).toBe(42);
  });

  it("returns 128 + signum when the child died by signal", () => {
    expect(translateExit({ exitCode: 0, signal: 2 })).toBe(130); // SIGINT
    expect(translateExit({ exitCode: 0, signal: 15 })).toBe(143); // SIGTERM
    expect(translateExit({ exitCode: 0, signal: 1 })).toBe(129); // SIGHUP
  });

  it("prefers signal over exitCode when both are present", () => {
    // node-pty sometimes reports both; signal is the more accurate cause-of-death.
    expect(translateExit({ exitCode: 1, signal: 2 })).toBe(130);
  });

  it("clamps to 255 on absurd signum values (defensive)", () => {
    expect(translateExit({ exitCode: 0, signal: 200 })).toBe(255);
  });

  it("falls back to exitCode when signal is 0", () => {
    // signum 0 is not a real signal; treat as 'no signal'.
    expect(translateExit({ exitCode: 7, signal: 0 })).toBe(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @aether/limbo-host exec vitest run src/pty/exit-code.test.ts
```

Expected: FAIL — `Cannot find module './exit-code.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/host/src/pty/exit-code.ts`:

```typescript
import type { PtyExit } from "./types.js";

const MAX_EXIT_CODE = 255;
const SIGNAL_OFFSET = 128;

/**
 * Translate a node-pty exit event into the numeric exit code limbo should
 * propagate to its own parent shell.
 *
 * Convention: POSIX 128 + signum for signal-induced death. This is what
 * `bash` reports in `$?` after a child is killed by a signal, so wrapping
 * scripts (CI, oncall runbooks, `set -e` chains) see the same value whether
 * they invoke `claude` or `limbo`.
 */
export function translateExit(event: PtyExit): number {
  const sig = event.signal;
  if (sig !== undefined && sig > 0) {
    return Math.min(SIGNAL_OFFSET + sig, MAX_EXIT_CODE);
  }
  return event.exitCode;
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm --filter @aether/limbo-host exec vitest run src/pty/exit-code.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/pty/exit-code.ts packages/host/src/pty/exit-code.test.ts
git commit -m "feat(host): translate PTY exit to POSIX 128+signum exit code"
```

---

## Task 3: TerminalGuard (TDD)

**Files:**
- Create: `packages/host/src/terminal/terminal-guard.test.ts`
- Create: `packages/host/src/terminal/terminal-guard.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/host/src/terminal/terminal-guard.test.ts`:

```typescript
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalGuard } from "./terminal-guard.js";

interface FakeStdin extends EventEmitter {
  isTTY: boolean;
  setRawMode: (raw: boolean) => FakeStdin;
  rawState: boolean;
}

function makeStdin(isTTY = true): FakeStdin {
  const e = new EventEmitter() as FakeStdin;
  e.isTTY = isTTY;
  e.rawState = false;
  e.setRawMode = (raw: boolean) => {
    e.rawState = raw;
    return e;
  };
  return e;
}

describe("TerminalGuard", () => {
  let proc: EventEmitter;
  let exitSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    proc = new EventEmitter();
    exitSpy = vi.fn();
  });

  afterEach(() => {
    proc.removeAllListeners();
  });

  it("puts a TTY stdin into raw mode on enter and restores it on restore", () => {
    const stdin = makeStdin();
    const g = new TerminalGuard({ stdin, process: proc, exit: exitSpy });
    g.enter();
    expect(stdin.rawState).toBe(true);
    g.restore();
    expect(stdin.rawState).toBe(false);
  });

  it("is idempotent: a second enter or restore is a no-op", () => {
    const stdin = makeStdin();
    const g = new TerminalGuard({ stdin, process: proc, exit: exitSpy });
    g.enter();
    g.enter();
    g.restore();
    g.restore();
    expect(stdin.rawState).toBe(false);
  });

  it("does nothing to stdin when it is not a TTY (eg. piped tests)", () => {
    const stdin = makeStdin(false);
    const setRaw = vi.spyOn(stdin, "setRawMode");
    const g = new TerminalGuard({ stdin, process: proc, exit: exitSpy });
    g.enter();
    g.restore();
    expect(setRaw).not.toHaveBeenCalled();
  });

  it("restores raw mode when the process emits 'exit'", () => {
    const stdin = makeStdin();
    const g = new TerminalGuard({ stdin, process: proc, exit: exitSpy });
    g.enter();
    proc.emit("exit");
    expect(stdin.rawState).toBe(false);
    g.restore(); // safety
  });

  it("on uncaughtException: restores raw mode and exits 1", () => {
    const stdin = makeStdin();
    const g = new TerminalGuard({ stdin, process: proc, exit: exitSpy });
    g.enter();
    proc.emit("uncaughtException", new Error("boom"));
    expect(stdin.rawState).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @aether/limbo-host exec vitest run src/terminal/terminal-guard.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/host/src/terminal/terminal-guard.ts`:

```typescript
import type { EventEmitter } from "node:events";

interface RawCapableStream {
  isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
}

interface TerminalGuardDeps {
  readonly stdin: RawCapableStream;
  readonly process: EventEmitter;
  readonly exit: (code: number) => void;
}

const HANDLED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type HandledSignal = (typeof HANDLED_SIGNALS)[number];

/**
 * Owns terminal-state side effects so the host shell is left clean no matter
 * how limbo dies. Two-step lifecycle:
 *
 *   guard.enter()   // raw mode + handlers attached
 *   try { ... } finally { guard.restore() }
 *
 * Plus belt-and-braces handlers (process 'exit', 'uncaughtException', signals)
 * so a panic in any layer still drops the user back into a usable shell.
 */
export class TerminalGuard {
  private entered = false;
  private wasTTY = false;
  private readonly onExit: () => void;
  private readonly onUncaught: (err: unknown) => void;
  private readonly signalHandlers: Map<HandledSignal, () => void>;

  constructor(private readonly deps: TerminalGuardDeps) {
    this.onExit = () => this.restore();
    this.onUncaught = (err) => {
      this.restore();
      process.stderr.write(`limbo: fatal: ${stringifyError(err)}\n`);
      this.deps.exit(1);
    };
    this.signalHandlers = new Map();
  }

  enter(): void {
    if (this.entered) return;
    this.entered = true;
    const { stdin, process: proc } = this.deps;
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
      this.wasTTY = true;
    }
    proc.on("exit", this.onExit);
    proc.on("uncaughtException", this.onUncaught);
  }

  restore(): void {
    if (!this.entered) return;
    this.entered = false;
    const { stdin, process: proc } = this.deps;
    if (this.wasTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }
    proc.off("exit", this.onExit);
    proc.off("uncaughtException", this.onUncaught);
    for (const [sig, handler] of this.signalHandlers) {
      proc.off(sig, handler);
    }
    this.signalHandlers.clear();
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm --filter @aether/limbo-host exec vitest run src/terminal/terminal-guard.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/terminal/terminal-guard.ts packages/host/src/terminal/terminal-guard.test.ts
git commit -m "feat(host): add TerminalGuard for raw-mode + panic safety"
```

---

## Task 4: PTY spawn factory (light test)

**Files:**
- Create: `packages/host/src/pty/spawn.ts`

- [ ] **Step 1: Write the implementation (no test — this is a thin adapter)**

Create `packages/host/src/pty/spawn.ts`:

```typescript
import { spawn as ptySpawn } from "node-pty";
import type { IPty, PtyFactory, PtySpawnOptions } from "./types.js";

/**
 * Default PTY factory: delegates to node-pty.
 *
 * Kept as a one-liner so the test surface stays in `wrapper.ts` (which
 * depends on the IPty interface, not the concrete factory). Tests in this
 * monorepo never exercise the real node-pty path — they inject MockPty.
 */
export const defaultPtyFactory: PtyFactory = (opts: PtySpawnOptions): IPty => {
  return ptySpawn(opts.file, [...opts.args], {
    name: "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
  });
};
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @aether/limbo-host run typecheck
```

Expected: clean. (node-pty's IPty is structurally compatible with our local IPty subset.)

- [ ] **Step 3: Commit**

```bash
git add packages/host/src/pty/spawn.ts
git commit -m "feat(host): add default node-pty factory"
```

---

## Task 5: `runWrapper` orchestrator (TDD with MockPty)

**Files:**
- Create: `packages/host/src/wrapper.test.ts`
- Create: `packages/host/src/wrapper.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/host/src/wrapper.test.ts`:

```typescript
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { IDisposable, IPty, PtyExit, PtySpawnOptions } from "./pty/types.js";
import { runWrapper } from "./wrapper.js";

class MockPty implements IPty {
  pid = 4242;
  cols: number;
  rows: number;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  readonly kills: Array<string | undefined> = [];
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<(e: PtyExit) => void> = [];

  constructor(opts: PtySpawnOptions) {
    this.cols = opts.cols;
    this.rows = opts.rows;
  }

  onData(l: (d: string) => void): IDisposable {
    this.dataListeners.push(l);
    return { dispose: () => undefined };
  }
  onExit(l: (e: PtyExit) => void): IDisposable {
    this.exitListeners.push(l);
    return { dispose: () => undefined };
  }
  write(d: string): void {
    this.writes.push(d);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
    this.cols = cols;
    this.rows = rows;
  }
  kill(signal?: string): void {
    this.kills.push(signal);
  }

  emitData(d: string): void {
    for (const l of this.dataListeners) l(d);
  }
  emitExit(e: PtyExit): void {
    for (const l of this.exitListeners) l(e);
  }
}

interface FakeStdin extends EventEmitter {
  isTTY: boolean;
  setRawMode: (raw: boolean) => FakeStdin;
}

function makeStdin(): FakeStdin {
  const e = new EventEmitter() as FakeStdin;
  e.isTTY = true;
  e.setRawMode = () => e;
  return e;
}

interface FakeStdout {
  columns: number;
  rows: number;
  write: (chunk: string) => boolean;
  written: string[];
}

function makeStdout(cols = 120, rows = 40): FakeStdout {
  const written: string[] = [];
  return {
    columns: cols,
    rows,
    write(chunk: string): boolean {
      written.push(chunk);
      return true;
    },
    written,
  };
}

function setup(initial?: { cols?: number; rows?: number }) {
  const stdin = makeStdin();
  const stdout = makeStdout(initial?.cols ?? 120, initial?.rows ?? 40);
  const proc = new EventEmitter();
  let captured: MockPty | undefined;
  const factory = vi.fn((opts: PtySpawnOptions): IPty => {
    captured = new MockPty(opts);
    return captured;
  });
  const promise = runWrapper({
    claudeBin: "/fake/claude",
    argv: ["--foo", "bar"],
    env: { PATH: "/usr/bin" },
    cwd: "/tmp",
    stdin,
    stdout: stdout as unknown as NodeJS.WriteStream,
    process: proc as unknown as NodeJS.Process,
    ptyFactory: factory,
  });
  if (!captured) throw new Error("factory not invoked synchronously");
  return { stdin, stdout, proc, factory, pty: captured, promise };
}

describe("runWrapper", () => {
  it("spawns the PTY with claudeBin, argv, env, cwd, and current tty size", () => {
    const { factory, pty } = setup({ cols: 100, rows: 30 });
    expect(factory).toHaveBeenCalledOnce();
    const opts = factory.mock.calls[0]?.[0] as PtySpawnOptions;
    expect(opts.file).toBe("/fake/claude");
    expect(opts.args).toEqual(["--foo", "bar"]);
    expect(opts.env).toEqual({ PATH: "/usr/bin" });
    expect(opts.cwd).toBe("/tmp");
    expect(opts.cols).toBe(100);
    expect(opts.rows).toBe(30);
    pty.emitExit({ exitCode: 0 });
  });

  it("forwards child output bytes to stdout untouched", async () => {
    const { stdout, pty, promise } = setup();
    pty.emitData("hello \x1b[31mworld\x1b[0m\n");
    pty.emitExit({ exitCode: 0 });
    await promise;
    expect(stdout.written.join("")).toBe("hello \x1b[31mworld\x1b[0m\n");
  });

  it("forwards stdin bytes to the child untouched", () => {
    const { stdin, pty } = setup();
    stdin.emit("data", Buffer.from("abc"));
    stdin.emit("data", Buffer.from("\r"));
    expect(pty.writes).toEqual(["abc", "\r"]);
    pty.emitExit({ exitCode: 0 });
  });

  it("forwards SIGWINCH by re-resizing the PTY to current stdout dims", () => {
    const { stdout, proc, pty } = setup({ cols: 80, rows: 24 });
    stdout.columns = 132;
    stdout.rows = 50;
    proc.emit("SIGWINCH");
    expect(pty.resizes).toEqual([{ cols: 132, rows: 50 }]);
    pty.emitExit({ exitCode: 0 });
  });

  it.each([
    ["SIGINT", "SIGINT"],
    ["SIGTERM", "SIGTERM"],
    ["SIGHUP", "SIGHUP"],
  ])("forwards %s to the child instead of dying itself", (sigName, expected) => {
    const { proc, pty } = setup();
    proc.emit(sigName);
    expect(pty.kills).toEqual([expected]);
    pty.emitExit({ exitCode: 0, signal: 2 });
  });

  it("resolves with the translated exit code when the child exits normally", async () => {
    const { pty, promise } = setup();
    pty.emitExit({ exitCode: 7 });
    await expect(promise).resolves.toBe(7);
  });

  it("resolves with 128+signum when the child dies by signal", async () => {
    const { pty, promise } = setup();
    pty.emitExit({ exitCode: 0, signal: 2 });
    await expect(promise).resolves.toBe(130);
  });

  it("detaches stdin and signal listeners after the child exits", async () => {
    const { stdin, proc, pty, promise } = setup();
    pty.emitExit({ exitCode: 0 });
    await promise;
    expect(stdin.listenerCount("data")).toBe(0);
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGWINCH")).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @aether/limbo-host exec vitest run src/wrapper.test.ts
```

Expected: FAIL — `Cannot find module './wrapper.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/host/src/wrapper.ts`:

```typescript
import { translateExit } from "./pty/exit-code.js";
import type { IDisposable, IPty, PtyFactory } from "./pty/types.js";

interface WrapperStdin extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
}

interface WrapperStdout {
  readonly columns?: number;
  readonly rows?: number;
  write(chunk: string): boolean;
}

export interface RunWrapperOptions {
  readonly claudeBin: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdin: WrapperStdin;
  readonly stdout: WrapperStdout;
  readonly process: NodeJS.EventEmitter;
  readonly ptyFactory: PtyFactory;
}

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Spawn the wrapped binary inside a PTY and proxy bytes/signals/resizes in
 * both directions. Resolves with the numeric exit code limbo should propagate
 * to its parent shell (POSIX 128+signum on signal death).
 *
 * The byte path is intentionally a straight pipe — no buffering, no decoding,
 * no transformation. §4.3 (state detector) will tee a *copy* of the child's
 * output without inserting itself in this path.
 */
export function runWrapper(opts: RunWrapperOptions): Promise<number> {
  const cols = opts.stdout.columns ?? DEFAULT_COLS;
  const rows = opts.stdout.rows ?? DEFAULT_ROWS;
  const pty: IPty = opts.ptyFactory({
    file: opts.claudeBin,
    args: opts.argv,
    env: opts.env,
    cwd: opts.cwd,
    cols,
    rows,
  });

  const disposables: IDisposable[] = [];
  const onStdinData = (chunk: Buffer | string): void => {
    pty.write(typeof chunk === "string" ? chunk : chunk.toString("binary"));
  };
  opts.stdin.on("data", onStdinData);

  const onWinch = (): void => {
    const c = opts.stdout.columns ?? DEFAULT_COLS;
    const r = opts.stdout.rows ?? DEFAULT_ROWS;
    pty.resize(c, r);
  };
  opts.process.on("SIGWINCH", onWinch);

  const signalHandlers = new Map<ForwardedSignal, () => void>();
  for (const sig of FORWARDED_SIGNALS) {
    const handler = (): void => pty.kill(sig);
    signalHandlers.set(sig, handler);
    opts.process.on(sig, handler);
  }

  disposables.push(
    pty.onData((data) => {
      opts.stdout.write(data);
    }),
  );

  return new Promise<number>((resolve) => {
    disposables.push(
      pty.onExit((event) => {
        opts.stdin.off("data", onStdinData);
        opts.process.off("SIGWINCH", onWinch);
        for (const [sig, handler] of signalHandlers) {
          opts.process.off(sig, handler);
        }
        for (const d of disposables) d.dispose();
        resolve(translateExit(event));
      }),
    );
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm --filter @aether/limbo-host exec vitest run src/wrapper.test.ts
```

Expected: 9 passed (including 3 from the `it.each`).

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/wrapper.ts packages/host/src/wrapper.test.ts
git commit -m "feat(host): add runWrapper orchestrator with byte-level PTY proxy"
```

---

## Task 6: Wire `runWrapper` into `cli.ts`

**Files:**
- Modify: `packages/host/src/cli.ts`
- Modify: `packages/host/src/index.ts`

- [ ] **Step 1: Update `index.ts` exports**

Replace `packages/host/src/index.ts` with:

```typescript
export { ClaudeNotFoundError, resolveClaudeBin } from "./resolve-claude.js";
export { translateExit } from "./pty/exit-code.js";
export { TerminalGuard } from "./terminal/terminal-guard.js";
export { runWrapper } from "./wrapper.js";
export type { IPty, PtyExit, PtyFactory, PtySpawnOptions } from "./pty/types.js";
export const VERSION = "0.0.0";
```

- [ ] **Step 2: Replace the stub in `cli.ts`**

Overwrite `packages/host/src/cli.ts`:

```typescript
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
```

- [ ] **Step 3: Build and run the existing version smoke**

```bash
pnpm --filter @aether/limbo-host run build
pnpm --filter @aether/limbo-host run smoke
```

Expected: prints `limbo 0.0.0` and `wraps: <Claude version>`. (Requires `claude` on `$PATH` locally.)

- [ ] **Step 4: Re-run all unit tests**

```bash
pnpm --filter @aether/limbo-host exec vitest run
```

Expected: all pre-existing + new tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/cli.ts packages/host/src/index.ts
git commit -m "feat(host): wire runWrapper into cli.ts; PTY pass-through is live"
```

---

## Task 7: End-to-end smoke test against fixtures

**Files:**
- Create: `packages/host/test/fixtures/exit-code.sh`
- Create: `packages/host/test/fixtures/echo-line.sh`
- Create: `packages/host/test/fixtures/wait.sh`
- Create: `packages/host/test/smoke.test.ts`
- Modify: `packages/host/vitest.config.ts` (extend `include` to pick up `test/**`)

- [ ] **Step 1: Create the fixture scripts**

Create `packages/host/test/fixtures/exit-code.sh`:

```bash
#!/bin/sh
exit "$1"
```

Create `packages/host/test/fixtures/echo-line.sh`:

```bash
#!/bin/sh
IFS= read -r line
printf '%s\n' "$line"
```

Create `packages/host/test/fixtures/wait.sh`:

```bash
#!/bin/sh
trap 'echo CAUGHT_TERM; exit 0' TERM
trap 'echo CAUGHT_INT; exit 0' INT
# Sleep in 1s chunks so traps fire promptly on macOS /bin/sh.
i=0
while [ $i -lt 60 ]; do
  sleep 1
  i=$((i + 1))
done
```

Make them executable:

```bash
chmod +x packages/host/test/fixtures/*.sh
```

- [ ] **Step 2: Extend vitest's include glob**

Edit `packages/host/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 15_000,
    reporters: process.env.CI ? ["default", "github-actions"] : ["default"],
  },
});
```

- [ ] **Step 3: Write the smoke test**

Create `packages/host/test/smoke.test.ts`:

```typescript
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

describeIfBuilt("limbo cli end-to-end through real PTY", () => {
  function spawnLimbo(claudeBin: string, args: string[] = []): {
    pid: number;
    onData: (cb: (s: string) => void) => void;
    onExit: () => Promise<{ exitCode: number; signal?: number }>;
    write: (s: string) => void;
    kill: (sig?: string) => void;
  } {
    const child = ptySpawn(process.execPath, [CLI, ...args], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: HERE,
      env: { ...process.env, CLAUDE_BIN: claudeBin },
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
```

- [ ] **Step 4: Run the smoke test**

```bash
pnpm --filter @aether/limbo-host exec vitest run test/smoke.test.ts
```

Expected: 3 passed. (Note: the `pretest` build hook from Task 1 means `pnpm --filter @aether/limbo-host test` builds first; for direct `vitest run` you may need `pnpm build` once.)

- [ ] **Step 5: Run full test suite**

```bash
pnpm --filter @aether/limbo-host run test
```

Expected: all unit + smoke tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/host/test/fixtures packages/host/test/smoke.test.ts packages/host/vitest.config.ts
git commit -m "test(host): add end-to-end PTY smoke test against shell fixtures"
```

---

## Task 8: README status + manual acceptance

**Files:**
- Modify: `README.md`
- Modify: `PLAN.md`

- [ ] **Step 1: Bump the status table in README.md**

In `README.md`, replace the line `| §4.2 Transparent PTY wrapper | not started |` with `| §4.2 Transparent PTY wrapper | done |`.

- [ ] **Step 2: Tick the §4.2 boxes in PLAN.md**

In `PLAN.md`, change every `- [ ]` under `### 4.2 Transparent PTY wrapper` to `- [x]`.

- [ ] **Step 3: Run the manual acceptance check**

```bash
pnpm --filter @aether/limbo-host run build
node packages/host/dist/cli.js
```

Drive Claude through limbo for one prompt; verify:
- prompt-and-response render byte-for-byte the same as bare `claude`
- `Ctrl+C` cancels the Claude turn (not limbo itself)
- Resizing the terminal mid-stream keeps output clean

If any acceptance step fails, file a follow-up under §4.3 detector work — *do not* paper over with output filtering in the wrapper.

- [ ] **Step 4: Commit**

```bash
git add README.md PLAN.md
git commit -m "docs: mark §4.2 PTY wrapper done; update status table"
```

---

## Self-Review

**Spec coverage (PLAN.md §4.2 checklist):**

| Spec line | Where it's implemented |
| --- | --- |
| Resolve `claude` from `PATH` | already done in §4.1 (`resolve-claude.ts`); reused in cli.ts |
| `pty.spawn(claudeBin, argv, …)` | Task 4 (`spawn.ts`) + Task 5 (called from `wrapper.ts`) |
| Set host stdin to raw, restore on exit/signal/panic | Task 3 (`TerminalGuard`) |
| Bidirectional pipe | Task 5 (`runWrapper.onStdinData` and `pty.onData → stdout.write`) |
| Forward `SIGWINCH` → `pty.resize` | Task 5 (`onWinch` handler) |
| Forward `SIGINT/SIGTERM/SIGHUP`; propagate exit code | Task 5 (`FORWARDED_SIGNALS`) + Task 2 (`translateExit`) |
| Acceptance: hooks/MCP/plugins identical | Task 8 manual check |

**Placeholder scan:** No "TBD", no "implement later", every step has concrete code or a concrete command.

**Type consistency:** `IPty`, `PtyExit`, `PtySpawnOptions`, `PtyFactory` defined once in `pty/types.ts` and used by name in `spawn.ts`, `wrapper.ts`, `wrapper.test.ts`, `index.ts`. `translateExit` signature `(event: PtyExit) => number` is consistent across `exit-code.ts` and `wrapper.ts`. `TerminalGuard` constructor signature is consistent across `terminal-guard.ts`, `terminal-guard.test.ts`, and `cli.ts`.
