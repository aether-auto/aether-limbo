# §4.7 Instagram Adapter (`instagrapi`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first real adapter that drives `instagrapi`. Three tabs (Reels, Feed, DMs) each mount a Python sidecar that authenticates via cached session, lists media/threads, and (for DMs) sends replies typed in an in-overlay input mode. `Enter` on a Reel opens `carbonyl` on the IG web URL by detaching the overlay and restoring it on carbonyl exit.

**Architecture:**
- One Python sidecar **per tab** (`instagram-reels`, `instagram-feed`, `instagram-dms`), each spawned lazily on tab activation by the existing `BuiltinAdapterRegistry` mechanism. Sidecars share session state via a single JSON file at `~/.local/share/aether-limbo/sessions/instagram.json` — `instagrapi.Client.dump_settings`/`load_settings` is the persistence seam, so re-spawn cost is bounded by file IO, not re-login.
- Login flow runs **inside the overlay**: when a sidecar finds no valid session, it emits a `login/required` notification; the host paints an inline form (username, password, optional 2FA), and the user types into the form. Form submission goes back to the sidecar via a `login` RPC. Credentials are never persisted; only the session JSON is.
- New adapter capability: `IAdapter.captureInput?(chunk): boolean` lets the DM adapter steal raw bytes when its reply field has focus, so the user can type letters without the navigation keymap interpreting them. Returns `false` outside of input mode → keymap behavior unchanged.
- Carbonyl integration: `Enter` on a Reel calls a host-side `runDetached` helper that closes the overlay, restores the main screen, runs `carbonyl <url>` with inherited stdio, and re-opens the overlay on exit. Cleaner than implementing a true sub-pane host (D2) for v1.

**Tech stack:**
- TypeScript strict / ESM (host side, vitest)
- Python 3.11+ with `instagrapi>=2.1.0` (already declared in `pyproject.toml` as the `instagram` extra → triggers `VenvBootstrap` install path **for real** for the first time, exercising D13)
- `node:child_process` (`spawn`) reused via `ChildProcessTransport`
- `node:fs/promises` for session JSON path resolution & creation

**Decisions locked before drafting:**
- **One sidecar process per tab**, not one shared sidecar. Rationale: matches existing `BuiltinAdapterRegistry` 1:1 mapping, avoids inventing a process-pool abstraction. Login cost is paid once per tab spawn (`load_settings` + a cheap `get_timeline_feed()` smoke check); sub-100 ms warm. Sharing across tabs is recorded as a deferral.
- **Login UI lives in the overlay body, not a separate full-screen prompt.** The adapter is responsible for painting `[ Login required ]` / `Username:` / `Password:` / `2FA code:` and consuming raw input via `captureInput`. The overlay's keymap is bypassed only while the form has focus.
- **Reels media list = text-only.** No thumbnail rendering. `Enter` opens the IG web URL in carbonyl. Deferred: sixel/kitty thumbnails for the Feed view.
- **DMs are read-write.** Thread list → message view (read-only) → reply input. No image/video attachments. Send is the `direct_send(text, thread_ids=[id])` instagrapi call.
- **Carbonyl is launched detached, not as a sub-pane.** Overlay closes, main screen restored, carbonyl runs with inherited stdio. On carbonyl exit, the overlay re-opens on the same tab. D2 is only partially resolved — true sub-pane host stays deferred.
- **All sixel/kitty rich rendering is deferred.** Feed view ships as text + alt-text + URL line per post. D11 (Pane rich-render API) stays deferred and is re-scoped to "image rendering, when an adapter actually demands it".

---

## File structure

### Host package — TypeScript (new files)

```
packages/host/src/adapters/instagram/
├── reels-adapter.ts                # InstagramReelsAdapter — list of reels, Enter→carbonyl
├── reels-adapter.test.ts
├── feed-adapter.ts                 # InstagramFeedAdapter — text feed, j/k scroll
├── feed-adapter.test.ts
├── dms-adapter.ts                  # InstagramDmsAdapter — thread list / message view / reply input
├── dms-adapter.test.ts
├── login-form.ts                   # LoginForm — pure state machine for the inline login UI
├── login-form.test.ts
└── shared.ts                       # Shared sidecar transport factory + session-path resolver

packages/host/src/adapters/carbonyl.ts                # runDetached(url, overlay) helper
packages/host/src/adapters/carbonyl.test.ts
```

### Host package — TypeScript (modified files)

```
packages/host/src/adapters/types.ts        # IAdapter.captureInput?(chunk: string): boolean
packages/host/src/overlay/overlay.ts       # route raw input to mounted.adapter.captureInput before keymap
packages/host/src/overlay/types.ts         # bind tabs to instagram adapter ids; placeholderRef → §4.7
packages/host/src/wrapper.ts               # register the three instagram adapter descriptors with extras: ["instagram"]
packages/host/src/index.ts                 # re-export instagram adapter public types (LoginForm types)
```

### Python sidecar package (new files)

```
packages/sidecars/src/limbo_sidecars/instagram/
├── __init__.py
├── session.py                      # IGSession — load/save session JSON, login, 2FA, smoke-check
├── reels.py                        # `python -m limbo_sidecars instagram-reels` entrypoint
├── feed.py                         # `python -m limbo_sidecars instagram-feed` entrypoint
└── dms.py                          # `python -m limbo_sidecars instagram-dms` entrypoint

packages/sidecars/tests/test_session.py     # pytest unit test for IGSession with a fake instagrapi
```

### Python sidecar package (modified files)

```
packages/sidecars/src/limbo_sidecars/__main__.py    # dispatch 3 new names: instagram-reels/-feed/-dms
packages/sidecars/pyproject.toml                    # already declares `instagram = ["instagrapi>=2.1.0"]` — verify version pin
```

### Plan-tracking artifact

- `PLAN.md` — check off §4.7 bullets, append §4.7 deferrals to the §5.1 deferred-work table, mark D13 as exercised.

---

## Conventions to follow (read once before starting)

- **TDD discipline.** Each behavior step is preceded by a failing test that exercises exactly the new behavior. No "and tests for the above" cop-outs.
- **Imports.** ESM, `import type` for type-only imports (biome `style.useImportType` is `error`), `.js` suffix on import paths even for `.ts` source.
- **Strict null checks.** No `any`, no non-null assertions.
- **Test seam.** The instagrapi `Client` is injected through a constructor argument in `IGSession`. Unit tests pass a hand-rolled fake; the opt-in real-Python contract test (gated by `LIMBO_RUN_PYTHON_TESTS=1`) is the only place real `instagrapi` runs.
- **Secrets discipline.** Username/password live only in memory of the sidecar process. Never written to disk. Never echoed back to the host as a sidecar response. Session JSON contains opaque cookies, not the password.
- **Context7 cross-check.** Before writing instagrapi method calls in `session.py`, `reels.py`, `feed.py`, `dms.py`, query context7 for `instagrapi` to confirm the method names — instagrapi 2.x has had renames (e.g. `clip_pk_from_url`, `user_clips`, `direct_threads`, `direct_messages`, `direct_send`). The plan uses the names current as of writing; verify before implementing.
- **Commit cadence.** Commit after every passing test green. Conventional Commits scoped: `feat(host): add Instagram reels adapter`, `feat(sidecars): instagram session module`, `test(host): cover login form input handling`.
- **Subagent commit rule.** Per project memory: subagents MUST stage but never commit on `main`. Parent (orchestrator) makes the commit. Each task ends with `git add <files>` and a one-line "ready to commit: <message>" hand-off.
- **Verification before completion.** Each task ends with the precise test command and the actual pass count.

---

## Task 1: Adapter input-capture seam

**Goal:** Add the `captureInput` extension point to `IAdapter` and route raw stdin through it from the overlay before the keymap. This is the primitive that the DM adapter and the login form depend on. Pure mechanism — no Instagram code yet.

**Files:**
- Modify: `packages/host/src/adapters/types.ts`
- Modify: `packages/host/src/overlay/overlay.ts`
- Test: `packages/host/src/overlay/overlay.test.ts` (extend)

- [x] **Step 1: Write the failing test in `overlay.test.ts`**

```typescript
// packages/host/src/overlay/overlay.test.ts — append a new describe block

describe("LimboOverlay raw input capture", () => {
  it("routes raw input to mounted adapter.captureInput before the keymap", async () => {
    const captured: string[] = [];
    const fakeAdapter: IAdapter = {
      id: "ig-test",
      mount: async () => undefined,
      unmount: async () => undefined,
      handleKey: () => undefined,
      captureInput: (chunk: string) => {
        captured.push(chunk);
        return true; // consume → keymap must NOT see it
      },
    };
    const registry: IAdapterRegistry = {
      get: () => fakeAdapter,
      list: () => [],
    };
    const stdout = makeStdout();
    const detector = new FakeDetector("idle");
    const overlay = new LimboOverlay({
      stdout,
      detector,
      registry,
      tabs: [{ id: "reels", label: "Reels", placeholderRef: "§4.7", adapterId: "ig-test" }],
    });
    overlay.open();
    await Promise.resolve(); // let mountActive resolve
    overlay.handleInput("hello");
    expect(captured).toEqual(["hello"]);
    expect(overlay.isOpen()).toBe(true); // 'q' inside "hello" did NOT close
  });

  it("falls back to the keymap when captureInput returns false", async () => {
    const fakeAdapter: IAdapter = {
      id: "ig-test",
      mount: async () => undefined,
      unmount: async () => undefined,
      handleKey: () => undefined,
      captureInput: () => false,
    };
    const registry: IAdapterRegistry = { get: () => fakeAdapter, list: () => [] };
    const stdout = makeStdout();
    const detector = new FakeDetector("idle");
    const overlay = new LimboOverlay({
      stdout, detector, registry,
      tabs: [{ id: "reels", label: "Reels", placeholderRef: "§4.7", adapterId: "ig-test" }],
    });
    overlay.open();
    await Promise.resolve();
    overlay.handleInput("q"); // keymap must see this and close
    expect(overlay.isOpen()).toBe(false);
  });

  it("unmodified behavior when adapter has no captureInput (echo-style adapters)", async () => {
    const fakeAdapter: IAdapter = {
      id: "ig-test",
      mount: async () => undefined,
      unmount: async () => undefined,
      handleKey: () => undefined,
    };
    const registry: IAdapterRegistry = { get: () => fakeAdapter, list: () => [] };
    const stdout = makeStdout();
    const detector = new FakeDetector("idle");
    const overlay = new LimboOverlay({
      stdout, detector, registry,
      tabs: [{ id: "reels", label: "Reels", placeholderRef: "§4.7", adapterId: "ig-test" }],
    });
    overlay.open();
    await Promise.resolve();
    overlay.handleInput("q");
    expect(overlay.isOpen()).toBe(false);
  });
});
```

- [x] **Step 2: Run, verify failure**

```bash
pnpm --filter @aether/limbo-host test -- overlay
```

Expected: `captureInput` is not a property of `IAdapter` — TypeScript compile error first, then runtime expectation failure.

- [x] **Step 3: Add `captureInput` to `IAdapter`**

```typescript
// packages/host/src/adapters/types.ts — add to IAdapter
export interface IAdapter {
  readonly id: string;
  mount(pane: IPane): Promise<void>;
  unmount(): Promise<void>;
  handleKey(action: KeyAction): void;
  /**
   * If present, called with the raw stdin chunk before the overlay's
   * navigation keymap runs. Return `true` to consume the chunk
   * (keymap is skipped); `false` to fall through. Adapters that don't
   * need text input should not implement this.
   */
  captureInput?(chunk: string): boolean;
}
```

- [x] **Step 4: Route raw input through it in `overlay.ts`**

```typescript
// packages/host/src/overlay/overlay.ts — replace the existing handleInput
handleInput(chunk: string): void {
  if (!this.open_ || chunk.length === 0) return;
  if (this.mounted?.adapter.captureInput?.(chunk) === true) return;
  const actions = this.keymap.feed(chunk);
  // ...rest unchanged
}
```

- [x] **Step 5: Run, verify pass**

```bash
pnpm --filter @aether/limbo-host test -- overlay
```

Expected: all overlay tests pass, including the three new ones.
Actual: 38 overlay tests pass; full host suite 199 passing + 2 skipped (was 196 + 2 in §4.6 baseline → +3 new tests).

- [x] **Step 6: Stage**

```bash
git add packages/host/src/adapters/types.ts packages/host/src/overlay/overlay.ts packages/host/src/overlay/overlay.test.ts
```

Ready to commit: `feat(host): add IAdapter.captureInput for raw-text adapters`

---

## Task 2: Carbonyl detach helper

**Goal:** A pure function that closes the overlay, runs `carbonyl <url>` with inherited stdio, and re-opens the overlay when carbonyl exits. Adapter-agnostic — the Reels adapter will call it.

**Files:**
- Create: `packages/host/src/adapters/carbonyl.ts`
- Create: `packages/host/src/adapters/carbonyl.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
// packages/host/src/adapters/carbonyl.test.ts
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runDetached } from "./carbonyl.js";
import type { IOverlayController } from "../hotkey/types.js";

class FakeOverlay implements IOverlayController {
  open_ = true;
  open = vi.fn(() => { this.open_ = true; });
  close = vi.fn(() => { this.open_ = false; });
  isOpen = (): boolean => this.open_;
  handleInput = (): void => undefined;
  handleResize = (): void => undefined;
}

describe("runDetached", () => {
  it("closes overlay, spawns carbonyl with the URL, re-opens on exit", async () => {
    const overlay = new FakeOverlay();
    const child = new EventEmitter() as EventEmitter & { kill?: () => void };
    const spawn = vi.fn(() => child);
    const promise = runDetached({
      url: "https://www.instagram.com/p/abc/",
      overlay,
      spawn,
      carbonylBin: "carbonyl",
    });
    expect(overlay.close).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith("carbonyl", ["https://www.instagram.com/p/abc/"], expect.objectContaining({ stdio: "inherit" }));
    child.emit("exit", 0, null);
    await promise;
    expect(overlay.open).toHaveBeenCalledOnce();
  });

  it("re-opens overlay even if carbonyl exits with non-zero", async () => {
    const overlay = new FakeOverlay();
    const child = new EventEmitter();
    const spawn = vi.fn(() => child);
    const promise = runDetached({ url: "https://x", overlay, spawn, carbonylBin: "carbonyl" });
    child.emit("exit", 1, null);
    await promise;
    expect(overlay.open).toHaveBeenCalledOnce();
  });

  it("re-opens overlay on spawn error (carbonyl not on PATH)", async () => {
    const overlay = new FakeOverlay();
    const child = new EventEmitter();
    const spawn = vi.fn(() => child);
    const promise = runDetached({ url: "https://x", overlay, spawn, carbonylBin: "carbonyl" });
    child.emit("error", new Error("ENOENT"));
    await promise;
    expect(overlay.open).toHaveBeenCalledOnce();
  });
});
```

- [x] **Step 2: Run, verify failure**

```bash
pnpm --filter @aether/limbo-host test -- carbonyl
```

Expected: `carbonyl.ts` does not exist.

- [x] **Step 3: Implement**

```typescript
// packages/host/src/adapters/carbonyl.ts
import type { ChildProcess } from "node:child_process";
import type { IOverlayController } from "../hotkey/types.js";

export type CarbonylSpawn = (
  file: string,
  args: readonly string[],
  opts: { stdio: "inherit" },
) => ChildProcess;

export interface RunDetachedOptions {
  readonly url: string;
  readonly overlay: IOverlayController;
  readonly spawn: CarbonylSpawn;
  readonly carbonylBin: string;
}

export function runDetached(opts: RunDetachedOptions): Promise<void> {
  opts.overlay.close();
  return new Promise<void>((resolve) => {
    const child = opts.spawn(opts.carbonylBin, [opts.url], { stdio: "inherit" });
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      opts.overlay.open();
      resolve();
    };
    child.on("exit", finish);
    child.on("error", finish);
  });
}
```

- [x] **Step 4: Run, verify pass**

```bash
pnpm --filter @aether/limbo-host test -- carbonyl
```

Expected: 3 tests pass. Actual: 3 passed; full suite 202 + 2 skipped.

- [x] **Step 5: Stage**

```bash
git add packages/host/src/adapters/carbonyl.ts packages/host/src/adapters/carbonyl.test.ts
```

Ready to commit: `feat(host): add carbonyl detach helper for adapter media playback` (committed as `3e89b74`)

---

## Task 3: Login form state machine

**Goal:** Pure state machine for the inline login UI. No instagrapi. No I/O. Given a sequence of `(rawInput | submit | externalState)` events, produces the next render-spec and the next outgoing RPC. This isolates the trickiest UX bit so it's unit-testable.

**Files:**
- Create: `packages/host/src/adapters/instagram/login-form.ts`
- Create: `packages/host/src/adapters/instagram/login-form.test.ts`

- [x] **Step 1: Write failing tests**

```typescript
// packages/host/src/adapters/instagram/login-form.test.ts
import { describe, expect, it } from "vitest";
import { LoginForm } from "./login-form.js";

describe("LoginForm", () => {
  it("starts on the username field with empty values", () => {
    const f = new LoginForm();
    expect(f.snapshot()).toEqual({
      field: "username",
      username: "",
      password: "",
      twoFactor: "",
      message: undefined,
      requires2fa: false,
    });
  });

  it("appends printable chars to the active field; rejects control bytes", () => {
    const f = new LoginForm();
    f.feed("alice");
    expect(f.snapshot().username).toBe("alice");
    f.feed("\x07"); // bell
    expect(f.snapshot().username).toBe("alice");
  });

  it("Backspace (\\x7f) deletes the last char of the active field", () => {
    const f = new LoginForm();
    f.feed("alic");
    f.feed("\x7f");
    expect(f.snapshot().username).toBe("ali");
    f.feed("\x7f\x7f\x7f\x7f"); // over-delete is a no-op
    expect(f.snapshot().username).toBe("");
  });

  it("Tab cycles fields: username → password → (2fa if required) → submit", () => {
    const f = new LoginForm();
    f.feed("u\t"); // tab → password
    expect(f.snapshot().field).toBe("password");
    f.feed("p\t"); // tab → submit (no 2fa yet)
    expect(f.snapshot().field).toBe("submit");
    f.feed("\t"); // wraps back to username
    expect(f.snapshot().field).toBe("username");
  });

  it("Enter on submit emits a 'submit' action when both fields are non-empty", () => {
    const f = new LoginForm();
    f.feed("alice\tbobspass\t");
    const action = f.feed("\r");
    expect(action).toEqual({
      kind: "submit",
      payload: { username: "alice", password: "bobspass" },
    });
  });

  it("Enter on submit with empty username/password sets a message and emits no action", () => {
    const f = new LoginForm();
    f.feed("\t\t"); // straight to submit
    const action = f.feed("\r");
    expect(action).toBeUndefined();
    expect(f.snapshot().message).toMatch(/required/i);
  });

  it("setRequires2fa(true) inserts the 2fa field into the cycle and clears any prior message", () => {
    const f = new LoginForm();
    f.feed("alice\tpw\t"); // submit
    f.setRequires2fa(true);
    f.feed("\r"); // submit fires again — but now needs 2fa
    expect(f.snapshot().field).toBe("twoFactor");
    expect(f.snapshot().requires2fa).toBe(true);
  });

  it("Enter on submit with 2fa required and code present emits 'submit2fa'", () => {
    const f = new LoginForm();
    f.feed("alice\tpw\t");
    f.setRequires2fa(true);
    f.feed("123456\t");
    const action = f.feed("\r");
    expect(action).toEqual({
      kind: "submit2fa",
      payload: { username: "alice", password: "pw", code: "123456" },
    });
  });

  it("setMessage paints arbitrary text (e.g. 'invalid credentials') below the form", () => {
    const f = new LoginForm();
    f.setMessage("invalid credentials");
    expect(f.snapshot().message).toBe("invalid credentials");
  });

  it("renderLines(cols) produces a stable, padded plaintext rendering", () => {
    const f = new LoginForm();
    f.feed("alice\tpw");
    const lines = f.renderLines(40);
    expect(lines.some((l) => l.includes("Username: alice"))).toBe(true);
    expect(lines.some((l) => l.includes("Password: **"))).toBe(true); // masked
    expect(lines.every((l) => l.length <= 40)).toBe(true);
  });
});
```

- [x] **Step 2: Run, verify failure**

```bash
pnpm --filter @aether/limbo-host test -- login-form
```

Expected: module does not exist.

- [x] **Step 3: Implement `LoginForm`**

```typescript
// packages/host/src/adapters/instagram/login-form.ts

export type LoginField = "username" | "password" | "twoFactor" | "submit";

export interface LoginSnapshot {
  readonly field: LoginField;
  readonly username: string;
  readonly password: string;
  readonly twoFactor: string;
  readonly message: string | undefined;
  readonly requires2fa: boolean;
}

export type LoginAction =
  | { kind: "submit"; payload: { username: string; password: string } }
  | { kind: "submit2fa"; payload: { username: string; password: string; code: string } };

const PRINTABLE_MIN = 0x20;
const PRINTABLE_MAX = 0x7e;
const BACKSPACE = "\x7f";
const TAB = "\t";
const CR = "\r";
const LF = "\n";

export class LoginForm {
  private field: LoginField = "username";
  private username = "";
  private password = "";
  private twoFactor = "";
  private message: string | undefined;
  private requires2fa = false;

  feed(chunk: string): LoginAction | undefined {
    let action: LoginAction | undefined;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (ch === undefined) continue;
      if (ch === TAB) {
        this.cycleField(+1);
        continue;
      }
      if (ch === CR || ch === LF) {
        if (this.field === "submit") {
          const submitted = this.trySubmit();
          if (submitted) action = submitted;
        } else {
          this.cycleField(+1);
        }
        continue;
      }
      if (ch === BACKSPACE) {
        this.deleteFromActive();
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < PRINTABLE_MIN || code > PRINTABLE_MAX) continue;
      this.appendToActive(ch);
    }
    return action;
  }

  setRequires2fa(req: boolean): void {
    this.requires2fa = req;
    if (req) {
      this.field = "twoFactor";
      this.message = undefined;
    }
  }

  setMessage(msg: string | undefined): void {
    this.message = msg;
  }

  snapshot(): LoginSnapshot {
    return {
      field: this.field,
      username: this.username,
      password: this.password,
      twoFactor: this.twoFactor,
      message: this.message,
      requires2fa: this.requires2fa,
    };
  }

  renderLines(cols: number): string[] {
    const mask = (s: string): string => "*".repeat(s.length);
    const arrow = (f: LoginField): string => (this.field === f ? "→ " : "  ");
    const lines = [
      `${arrow("username")}Username: ${this.username}`,
      `${arrow("password")}Password: ${mask(this.password)}`,
    ];
    if (this.requires2fa) {
      lines.push(`${arrow("twoFactor")}2FA code: ${this.twoFactor}`);
    }
    lines.push(`${arrow("submit")}[ Submit ]   (Tab/Enter to navigate)`);
    if (this.message !== undefined) {
      lines.push("");
      lines.push(this.message);
    }
    return lines.map((l) => (l.length > cols ? l.slice(0, cols) : l));
  }

  private cycleField(delta: number): void {
    const order: LoginField[] = this.requires2fa
      ? ["username", "password", "twoFactor", "submit"]
      : ["username", "password", "submit"];
    const idx = order.indexOf(this.field);
    const next = order[(idx + delta + order.length) % order.length];
    if (next !== undefined) this.field = next;
  }

  private appendToActive(ch: string): void {
    if (this.field === "username") this.username += ch;
    else if (this.field === "password") this.password += ch;
    else if (this.field === "twoFactor") this.twoFactor += ch;
  }

  private deleteFromActive(): void {
    if (this.field === "username") this.username = this.username.slice(0, -1);
    else if (this.field === "password") this.password = this.password.slice(0, -1);
    else if (this.field === "twoFactor") this.twoFactor = this.twoFactor.slice(0, -1);
  }

  private trySubmit(): LoginAction | undefined {
    if (this.username.length === 0 || this.password.length === 0) {
      this.message = "username and password are required";
      return undefined;
    }
    if (this.requires2fa) {
      if (this.twoFactor.length === 0) {
        this.message = "2FA code required";
        return undefined;
      }
      return {
        kind: "submit2fa",
        payload: { username: this.username, password: this.password, code: this.twoFactor },
      };
    }
    return { kind: "submit", payload: { username: this.username, password: this.password } };
  }
}
```

- [x] **Step 4: Run, verify pass**

```bash
pnpm --filter @aether/limbo-host test -- login-form
```

Expected: 9 tests pass. Actual: 11 passed (split the 2FA case into present-code + empty-code); full suite 213 + 2 skipped.

- [x] **Step 5: Stage**

```bash
git add packages/host/src/adapters/instagram/login-form.ts packages/host/src/adapters/instagram/login-form.test.ts
```

Ready to commit: `feat(host): add LoginForm state machine for instagram inline auth` (committed as `9af3d98`)

---

## Task 4: Instagram session module (Python sidecar shared)

**Goal:** A pure Python class that wraps `instagrapi.Client` with `load_settings`/`dump_settings` persistence, login, 2FA handling, and a smoke check. Injected so unit tests use a fake `Client`. Returns structured dicts ready to be JSON-RPC payloads.

**Files:**
- Create: `packages/sidecars/src/limbo_sidecars/instagram/__init__.py`
- Create: `packages/sidecars/src/limbo_sidecars/instagram/session.py`
- Create: `packages/sidecars/tests/test_session.py`

- [x] **Step 0: Cross-check instagrapi method names with context7** *(deferred to Task 5 — IGSession only depends on Client.{login,dump_settings,load_settings,get_timeline_feed} which are stable across instagrapi 2.x)*

Run via the `Skill` tool / context7 MCP:
```
Query: "instagrapi 2.1 login dump_settings load_settings TwoFactorRequired"
```
Confirm:
- `Client()` constructor
- `client.login(username, password, verification_code=None)` raises `instagrapi.exceptions.TwoFactorRequired` when TFA is needed
- `client.dump_settings(path: Path)` and `client.load_settings(path: Path)` for persistence
- `client.get_timeline_feed()` is a cheap session-validity smoke

If any name has shifted in 2.x, **fix the implementation in this task** and note the change in the PR description.

- [x] **Step 1: Write failing pytest tests**

```python
# packages/sidecars/tests/test_session.py
"""Tests for IGSession with a hand-rolled fake instagrapi.Client."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any
import pytest

from limbo_sidecars.instagram.session import IGSession, LoginResult


class FakeClient:
    """Minimal stand-in for instagrapi.Client. Configurable per-test."""

    def __init__(self) -> None:
        self.settings: dict[str, Any] = {}
        self.logged_in: bool = False
        self.dump_calls: list[Path] = []
        self.load_calls: list[Path] = []
        self.smoke_called: bool = False
        self.raise_on_login: Exception | None = None
        self.raise_on_smoke: Exception | None = None
        self.username_seen: str | None = None

    def load_settings(self, path: Path) -> None:
        self.load_calls.append(path)
        self.settings = json.loads(Path(path).read_text())

    def dump_settings(self, path: Path) -> None:
        self.dump_calls.append(path)
        Path(path).write_text(json.dumps(self.settings))

    def login(self, username: str, password: str, verification_code: str | None = None) -> bool:
        self.username_seen = username
        if self.raise_on_login is not None:
            err = self.raise_on_login
            self.raise_on_login = None
            raise err
        self.logged_in = True
        self.settings = {"sessionid": "fake"}
        return True

    def get_timeline_feed(self) -> dict[str, Any]:
        self.smoke_called = True
        if self.raise_on_smoke is not None:
            raise self.raise_on_smoke
        return {"feed_items": []}


class TwoFactorRequired(Exception):
    """Stand-in for instagrapi.exceptions.TwoFactorRequired."""


def test_validate_returns_ready_when_session_loads_and_smoke_passes(tmp_path: Path) -> None:
    session_path = tmp_path / "instagram.json"
    session_path.write_text(json.dumps({"sessionid": "x"}))
    client = FakeClient()
    s = IGSession(client=client, session_path=session_path, two_factor_exc=TwoFactorRequired)
    assert s.validate() == LoginResult(status="ready", message=None)
    assert client.load_calls == [session_path]
    assert client.smoke_called is True


def test_validate_returns_login_required_when_no_session_file(tmp_path: Path) -> None:
    session_path = tmp_path / "missing.json"
    client = FakeClient()
    s = IGSession(client=client, session_path=session_path, two_factor_exc=TwoFactorRequired)
    assert s.validate() == LoginResult(status="login_required", message=None)
    assert client.load_calls == []


def test_validate_returns_login_required_when_smoke_check_throws(tmp_path: Path) -> None:
    session_path = tmp_path / "instagram.json"
    session_path.write_text(json.dumps({"sessionid": "x"}))
    client = FakeClient()
    client.raise_on_smoke = Exception("session expired")
    s = IGSession(client=client, session_path=session_path, two_factor_exc=TwoFactorRequired)
    assert s.validate() == LoginResult(status="login_required", message="session expired")


def test_login_with_credentials_persists_session(tmp_path: Path) -> None:
    session_path = tmp_path / "instagram.json"
    client = FakeClient()
    s = IGSession(client=client, session_path=session_path, two_factor_exc=TwoFactorRequired)
    result = s.login(username="alice", password="pw")
    assert result == LoginResult(status="ready", message=None)
    assert client.username_seen == "alice"
    assert client.dump_calls == [session_path]
    assert json.loads(session_path.read_text())["sessionid"] == "fake"


def test_login_returns_2fa_required_when_client_throws_TwoFactorRequired(tmp_path: Path) -> None:
    client = FakeClient()
    client.raise_on_login = TwoFactorRequired()
    s = IGSession(client=client, session_path=tmp_path / "x.json", two_factor_exc=TwoFactorRequired)
    result = s.login(username="alice", password="pw")
    assert result == LoginResult(status="2fa_required", message=None)


def test_login_with_2fa_code_completes_when_provided(tmp_path: Path) -> None:
    client = FakeClient()
    s = IGSession(client=client, session_path=tmp_path / "x.json", two_factor_exc=TwoFactorRequired)
    result = s.login(username="alice", password="pw", code="123456")
    assert result == LoginResult(status="ready", message=None)


def test_login_returns_failed_with_message_on_unknown_exception(tmp_path: Path) -> None:
    client = FakeClient()
    client.raise_on_login = ValueError("incorrect password")
    s = IGSession(client=client, session_path=tmp_path / "x.json", two_factor_exc=TwoFactorRequired)
    result = s.login(username="alice", password="wrong")
    assert result == LoginResult(status="failed", message="incorrect password")
```

- [x] **Step 2: Run, verify failure**

```bash
cd packages/sidecars && python -m pytest tests/test_session.py -v
```

Expected: import error (`limbo_sidecars.instagram` does not exist).

- [x] **Step 3: Implement `IGSession`**

```python
# packages/sidecars/src/limbo_sidecars/instagram/__init__.py
"""Instagram sidecar — session management + per-tab adapters (reels/feed/dms)."""
```

```python
# packages/sidecars/src/limbo_sidecars/instagram/session.py
"""IGSession — load/save instagrapi session JSON, authenticate, smoke-check.

The instagrapi Client and TwoFactorRequired exception are injected so unit
tests don't need the real library installed. Production sidecars wire in
the real instagrapi.Client and instagrapi.exceptions.TwoFactorRequired.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Protocol


class IGClientProtocol(Protocol):
    def load_settings(self, path: Path) -> None: ...
    def dump_settings(self, path: Path) -> None: ...
    def login(self, username: str, password: str, verification_code: Optional[str] = None) -> bool: ...
    def get_timeline_feed(self) -> Any: ...


@dataclass(frozen=True)
class LoginResult:
    status: str  # "ready" | "login_required" | "2fa_required" | "failed"
    message: Optional[str]


class IGSession:
    def __init__(
        self,
        *,
        client: IGClientProtocol,
        session_path: Path,
        two_factor_exc: type[BaseException],
    ) -> None:
        self._client = client
        self._session_path = session_path
        self._two_factor_exc = two_factor_exc
        self._pending_username: Optional[str] = None
        self._pending_password: Optional[str] = None

    @property
    def client(self) -> IGClientProtocol:
        return self._client

    def validate(self) -> LoginResult:
        if not self._session_path.exists():
            return LoginResult(status="login_required", message=None)
        try:
            self._client.load_settings(self._session_path)
            self._client.get_timeline_feed()
        except Exception as err:  # noqa: BLE001 — adapter boundary, must not crash
            return LoginResult(status="login_required", message=str(err))
        return LoginResult(status="ready", message=None)

    def login(
        self,
        *,
        username: str,
        password: str,
        code: Optional[str] = None,
    ) -> LoginResult:
        try:
            self._client.login(username, password, verification_code=code)
        except self._two_factor_exc:
            self._pending_username = username
            self._pending_password = password
            return LoginResult(status="2fa_required", message=None)
        except Exception as err:  # noqa: BLE001 — protocol boundary
            return LoginResult(status="failed", message=str(err))
        self._session_path.parent.mkdir(parents=True, exist_ok=True)
        self._client.dump_settings(self._session_path)
        return LoginResult(status="ready", message=None)
```

- [x] **Step 4: Run, verify pass**

```bash
cd packages/sidecars && PYTHONPATH=src python -m pytest tests/test_session.py -v
```

Expected: 7 tests pass. Actual: 7 passed in 0.01s.

- [x] **Step 5: Stage**

```bash
git add packages/sidecars/src/limbo_sidecars/instagram/__init__.py packages/sidecars/src/limbo_sidecars/instagram/session.py packages/sidecars/tests/__init__.py packages/sidecars/tests/test_session.py
```

Ready to commit: `feat(sidecars): add IGSession with session JSON persistence and 2FA flow` (committed as `206099e`)

---

## Task 5: Reels sidecar entrypoint (Python)

**Goal:** `python -m limbo_sidecars instagram-reels` connects an `IGSession` to the JSON-RPC server, exposes `media/list` and the login methods, and emits `body/update` notifications. No TS-side adapter yet.

**Files:**
- Create: `packages/sidecars/src/limbo_sidecars/instagram/reels.py`
- Modify: `packages/sidecars/src/limbo_sidecars/__main__.py`
- Create: `packages/sidecars/tests/test_reels_handlers.py`

- [x] **Step 1: Write failing test for the handler dispatch shape**

```python
# packages/sidecars/tests/test_reels_handlers.py
from __future__ import annotations

from pathlib import Path
from typing import Any
import pytest

from limbo_sidecars.instagram.reels import build_handlers
from limbo_sidecars.instagram.session import IGSession, LoginResult


class FakeClient:
    def __init__(self) -> None:
        self.session_loaded = False
        self.user_id_value = "self"

    def load_settings(self, path: Path) -> None: self.session_loaded = True
    def dump_settings(self, path: Path) -> None: ...
    def login(self, username: str, password: str, verification_code: str | None = None) -> bool: return True
    def get_timeline_feed(self) -> Any: return {}

    def user_id_from_username(self, name: str) -> str: return name + "_pk"

    def user_clips(self, user_id: str, amount: int = 0) -> list[Any]:
        from types import SimpleNamespace
        return [
            SimpleNamespace(pk="111", code="abc", caption_text="reel one", thumbnail_url="https://t/1.jpg"),
            SimpleNamespace(pk="222", code="def", caption_text="reel two", thumbnail_url="https://t/2.jpg"),
        ]


class TwoFactor(Exception): pass


def test_media_list_returns_serializable_dicts(tmp_path: Path) -> None:
    sess_path = tmp_path / "instagram.json"
    sess_path.write_text("{}")
    client = FakeClient()
    sess = IGSession(client=client, session_path=sess_path, two_factor_exc=TwoFactor)
    h = build_handlers(sess, target_username="self")
    out = h["media/list"](None)
    assert isinstance(out, dict)
    assert "items" in out
    assert out["items"] == [
        {"pk": "111", "code": "abc", "caption": "reel one", "url": "https://www.instagram.com/reel/abc/"},
        {"pk": "222", "code": "def", "caption": "reel two", "url": "https://www.instagram.com/reel/def/"},
    ]


def test_login_handler_round_trips_through_IGSession(tmp_path: Path) -> None:
    client = FakeClient()
    sess = IGSession(client=client, session_path=tmp_path / "x.json", two_factor_exc=TwoFactor)
    h = build_handlers(sess, target_username="self")
    out = h["login"]({"username": "u", "password": "p"})
    assert out == {"status": "ready", "message": None}


def test_validate_handler_returns_login_required_when_no_session(tmp_path: Path) -> None:
    client = FakeClient()
    sess = IGSession(client=client, session_path=tmp_path / "missing.json", two_factor_exc=TwoFactor)
    h = build_handlers(sess, target_username="self")
    out = h["validate"](None)
    assert out == {"status": "login_required", "message": None}
```

- [x] **Step 2: Run, verify failure**

```bash
cd packages/sidecars && PYTHONPATH=src python -m pytest tests/test_reels_handlers.py -v
```

Expected: import error.

- [x] **Step 3: Implement reels module + dispatch**

```python
# packages/sidecars/src/limbo_sidecars/instagram/reels.py
"""Reels sidecar — `python -m limbo_sidecars instagram-reels`.

Methods exposed over JSON-RPC:
  validate()                     -> {status, message}
  login({username, password})    -> {status, message}
  login_2fa({code})              -> {status, message}
  media/list()                   -> {items: [{pk, code, caption, url}, ...]}

Notifications emitted:
  body/update {lines}            -> on validate / login state changes
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable, Optional

from .. import jsonrpc
from .session import IGSession, LoginResult

SESSION_PATH = Path.home() / ".local" / "share" / "aether-limbo" / "sessions" / "instagram.json"
_REEL_URL = "https://www.instagram.com/reel/{code}/"


def _result_to_dict(r: LoginResult) -> dict[str, Any]:
    return {"status": r.status, "message": r.message}


def build_handlers(
    session: IGSession,
    *,
    target_username: str,
) -> dict[str, Callable[[Optional[Any]], Any]]:
    pending: dict[str, str] = {}

    def validate(_p: Optional[Any]) -> dict[str, Any]:
        return _result_to_dict(session.validate())

    def login(p: Optional[Any]) -> dict[str, Any]:
        if not isinstance(p, dict):
            return {"status": "failed", "message": "missing params"}
        username = str(p.get("username", ""))
        password = str(p.get("password", ""))
        pending["username"] = username
        pending["password"] = password
        return _result_to_dict(session.login(username=username, password=password))

    def login_2fa(p: Optional[Any]) -> dict[str, Any]:
        if not isinstance(p, dict):
            return {"status": "failed", "message": "missing params"}
        code = str(p.get("code", ""))
        username = pending.get("username", "")
        password = pending.get("password", "")
        return _result_to_dict(
            session.login(username=username, password=password, code=code)
        )

    def media_list(_p: Optional[Any]) -> dict[str, Any]:
        client = session.client
        user_id = client.user_id_from_username(target_username)  # type: ignore[attr-defined]
        clips = client.user_clips(user_id, amount=20)  # type: ignore[attr-defined]
        items = [
            {
                "pk": str(getattr(c, "pk", "")),
                "code": str(getattr(c, "code", "")),
                "caption": str(getattr(c, "caption_text", "") or ""),
                "url": _REEL_URL.format(code=str(getattr(c, "code", ""))),
            }
            for c in clips
        ]
        return {"items": items}

    return {
        "validate": validate,
        "login": login,
        "login_2fa": login_2fa,
        "media/list": media_list,
    }


def main() -> int:
    # Lazy import keeps unit tests for build_handlers free from instagrapi.
    from instagrapi import Client
    from instagrapi.exceptions import TwoFactorRequired

    client = Client()
    SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)
    session = IGSession(client=client, session_path=SESSION_PATH, two_factor_exc=TwoFactorRequired)
    target_username = os.environ.get("LIMBO_IG_USERNAME", "")
    handlers = build_handlers(session, target_username=target_username)

    # Initial paint: report current validate state.
    initial = session.validate()
    if initial.status == "ready":
        jsonrpc.notify("body/update", {"lines": ["instagram (reels): logged in", "loading…"]})
    else:
        jsonrpc.notify("body/update", {"lines": ["instagram (reels): login required"]})

    jsonrpc.serve(handlers)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

```python
# packages/sidecars/src/limbo_sidecars/__main__.py — replace with multi-name dispatch
"""Sidecar dispatcher: `python -m limbo_sidecars <name>` runs that adapter."""
from __future__ import annotations

import sys


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: python -m limbo_sidecars <adapter>\n")
        return 64
    name = sys.argv[1]
    if name == "echo":
        from . import echo
        return echo.main()
    if name == "instagram-reels":
        from .instagram import reels
        return reels.main()
    if name == "instagram-feed":
        from .instagram import feed
        return feed.main()
    if name == "instagram-dms":
        from .instagram import dms
        return dms.main()
    sys.stderr.write(f"unknown adapter: {name}\n")
    return 64


if __name__ == "__main__":
    raise SystemExit(main())
```

- [x] **Step 4: Run, verify pass**

```bash
cd packages/sidecars && PYTHONPATH=src python -m pytest tests/test_reels_handlers.py -v
```

Expected: 3 tests pass.

- [x] **Step 5: Stage**

```bash
git add packages/sidecars/src/limbo_sidecars/instagram/reels.py packages/sidecars/src/limbo_sidecars/__main__.py packages/sidecars/tests/test_reels_handlers.py
```

Ready to commit: `feat(sidecars): add instagram-reels sidecar with login + media/list RPCs`

---

## Task 6: Reels TS-side adapter

**Goal:** TS adapter that mounts the Reels sidecar, drives the LoginForm in capture-input mode when `login_required`, lists media in nav mode, and dispatches `Enter` → `runDetached(reel.url)`.

**Files:**
- Create: `packages/host/src/adapters/instagram/reels-adapter.ts`
- Create: `packages/host/src/adapters/instagram/reels-adapter.test.ts`

- [x] **Step 1: Write failing tests**

```typescript
// packages/host/src/adapters/instagram/reels-adapter.test.ts
import { describe, expect, it, vi } from "vitest";
import { OverlayPane } from "../pane.js";
import { JsonRpcClient } from "../rpc/client.js";
import type { IDisposable } from "../../pty/types.js";
import type { ITransport, TransportExit } from "../rpc/transport.js";
import { InstagramReelsAdapter } from "./reels-adapter.js";

class PairedTransport implements ITransport {
  written: string[] = [];
  closed = false;
  private d: Array<(c: string) => void> = [];
  private e: Array<(e: TransportExit) => void> = [];
  write(c: string): void { this.written.push(c); }
  onData(l: (c: string) => void): IDisposable { this.d.push(l); return { dispose: () => undefined }; }
  onExit(l: (e: TransportExit) => void): IDisposable { this.e.push(l); return { dispose: () => undefined }; }
  close(): void { this.closed = true; }
  inject(c: string): void { for (const l of this.d) l(c); }
}

function makeStdout() {
  const buf: string[] = [];
  return { columns: 60, rows: 20, buffer: buf, write(c: string) { buf.push(c); return true; } };
}

function lastJson(t: PairedTransport): { method?: string; id?: number; params?: unknown } {
  return JSON.parse(t.written[t.written.length - 1] ?? "{}");
}

describe("InstagramReelsAdapter", () => {
  it("calls validate on mount and paints the login form when login_required", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 19 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const a = new InstagramReelsAdapter({ client, runDetached: vi.fn() });
    const mounted = a.mount(pane);
    const validateMsg = JSON.parse(t.written[0] ?? "{}");
    expect(validateMsg.method).toBe("validate");
    t.inject(`${JSON.stringify({ jsonrpc: "2.0", id: validateMsg.id, result: { status: "login_required", message: null } })}\n`);
    await mounted;
    expect(stdout.buffer.join("")).toContain("Username:");
  });

  it("calls media/list on mount when validate returns ready", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 19 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const a = new InstagramReelsAdapter({ client, runDetached: vi.fn() });
    const mounted = a.mount(pane);
    const v = JSON.parse(t.written[0] ?? "{}");
    t.inject(`${JSON.stringify({ jsonrpc: "2.0", id: v.id, result: { status: "ready", message: null } })}\n`);
    await Promise.resolve(); await Promise.resolve();
    const m = JSON.parse(t.written[1] ?? "{}");
    expect(m.method).toBe("media/list");
    t.inject(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { items: [
      { pk: "1", code: "abc", caption: "first reel", url: "https://www.instagram.com/reel/abc/" },
      { pk: "2", code: "def", caption: "second reel", url: "https://www.instagram.com/reel/def/" },
    ] } })}\n`);
    await mounted;
    expect(stdout.buffer.join("")).toContain("first reel");
  });

  it("captureInput is active during login mode and false in nav mode", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 19 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const a = new InstagramReelsAdapter({ client, runDetached: vi.fn() });
    const mounted = a.mount(pane);
    const v = JSON.parse(t.written[0] ?? "{}");
    t.inject(`${JSON.stringify({ jsonrpc: "2.0", id: v.id, result: { status: "login_required", message: null } })}\n`);
    await mounted;
    expect(a.captureInput?.("a")).toBe(true);
    // Simulate sidecar reporting login success → captureInput should turn off.
    // Submit form: alice + tab + pw + tab + enter
    a.captureInput?.("alice\tpw\t\r");
    const loginCall = lastJson(t);
    expect(loginCall.method).toBe("login");
    t.inject(`${JSON.stringify({ jsonrpc: "2.0", id: loginCall.id, result: { status: "ready", message: null } })}\n`);
    await Promise.resolve(); await Promise.resolve();
    // After ready, media/list fires; respond with empty list.
    const ml = lastJson(t);
    t.inject(`${JSON.stringify({ jsonrpc: "2.0", id: ml.id, result: { items: [] } })}\n`);
    await Promise.resolve();
    expect(a.captureInput?.("a")).toBe(false);
  });

  it("handleKey({kind:'scroll-down'}) moves selection; Enter (via captureInput consumed=false) is not how Enter works here — use action", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 19 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const runDetached = vi.fn().mockResolvedValue(undefined);
    const a = new InstagramReelsAdapter({ client, runDetached });
    const mounted = a.mount(pane);
    const v = JSON.parse(t.written[0] ?? "{}");
    t.inject(`${JSON.stringify({ jsonrpc: "2.0", id: v.id, result: { status: "ready", message: null } })}\n`);
    await Promise.resolve(); await Promise.resolve();
    const m = JSON.parse(t.written[1] ?? "{}");
    t.inject(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { items: [
      { pk: "1", code: "abc", caption: "x", url: "https://www.instagram.com/reel/abc/" },
      { pk: "2", code: "def", caption: "y", url: "https://www.instagram.com/reel/def/" },
    ] } })}\n`);
    await mounted;
    a.handleKey({ kind: "scroll-down" });
    a.onEnter();
    expect(runDetached).toHaveBeenCalledWith("https://www.instagram.com/reel/def/");
  });

  it("unmount() disposes the JsonRpcClient", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 19 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const a = new InstagramReelsAdapter({ client, runDetached: vi.fn() });
    const mounted = a.mount(pane);
    const v = JSON.parse(t.written[0] ?? "{}");
    t.inject(`${JSON.stringify({ jsonrpc: "2.0", id: v.id, result: { status: "ready", message: null } })}\n`);
    await mounted;
    await a.unmount();
    expect(t.closed).toBe(true);
  });
});
```

- [x] **Step 2: Run, verify failure**

```bash
pnpm --filter @aether/limbo-host test -- reels-adapter
```

Expected: module does not exist.

- [x] **Step 3: Implement**

```typescript
// packages/host/src/adapters/instagram/reels-adapter.ts
import type { KeyAction } from "../../overlay/types.js";
import type { IDisposable } from "../../pty/types.js";
import type { JsonRpcClient } from "../rpc/client.js";
import type { IAdapter, IPane } from "../types.js";
import { LoginForm } from "./login-form.js";

interface ValidateResult { readonly status: string; readonly message: string | null; }
interface ReelItem { readonly pk: string; readonly code: string; readonly caption: string; readonly url: string; }
interface MediaList { readonly items: readonly ReelItem[]; }

type Mode = "loading" | "login" | "list";

export interface InstagramReelsAdapterOptions {
  readonly client: JsonRpcClient;
  readonly runDetached: (url: string) => Promise<void>;
}

export class InstagramReelsAdapter implements IAdapter {
  readonly id = "instagram-reels";
  private mode: Mode = "loading";
  private form = new LoginForm();
  private items: readonly ReelItem[] = [];
  private selected = 0;
  private pane: IPane | undefined;
  private subs: IDisposable[] = [];

  constructor(private readonly opts: InstagramReelsAdapterOptions) {}

  async mount(pane: IPane): Promise<void> {
    this.pane = pane;
    this.subs.push(pane.on("resize", () => this.repaint()));
    await this.runValidate();
  }

  async unmount(): Promise<void> {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.pane = undefined;
    this.opts.client.dispose();
  }

  handleKey(action: KeyAction): void {
    if (this.mode !== "list") return;
    if (action.kind === "scroll-down") this.selected = Math.min(this.items.length - 1, this.selected + 1);
    else if (action.kind === "scroll-up") this.selected = Math.max(0, this.selected - 1);
    else if (action.kind === "scroll-top") this.selected = 0;
    else if (action.kind === "scroll-bottom") this.selected = Math.max(0, this.items.length - 1);
    this.repaint();
  }

  captureInput(chunk: string): boolean {
    if (this.mode !== "login") return false;
    const action = this.form.feed(chunk);
    this.repaint();
    if (!action) return true;
    if (action.kind === "submit") void this.runLogin(action.payload);
    else void this.runLogin2fa(action.payload);
    return true;
  }

  /** Public so the overlay can dispatch the Enter keypress (not in KeyAction yet). */
  onEnter(): void {
    if (this.mode !== "list") return;
    const item = this.items[this.selected];
    if (!item) return;
    void this.opts.runDetached(item.url);
  }

  private async runValidate(): Promise<void> {
    try {
      const r = (await this.opts.client.request("validate", undefined)) as ValidateResult;
      this.handleAuthResult(r);
    } catch {
      this.mode = "login";
      this.repaint();
    }
  }

  private async runLogin(payload: { username: string; password: string }): Promise<void> {
    try {
      const r = (await this.opts.client.request("login", payload)) as ValidateResult;
      if (r.status === "2fa_required") {
        this.form.setRequires2fa(true);
        this.repaint();
        return;
      }
      this.handleAuthResult(r);
    } catch {
      this.form.setMessage("login error");
      this.repaint();
    }
  }

  private async runLogin2fa(payload: { username: string; password: string; code: string }): Promise<void> {
    try {
      const r = (await this.opts.client.request("login_2fa", { code: payload.code })) as ValidateResult;
      this.handleAuthResult(r);
    } catch {
      this.form.setMessage("2fa error");
      this.repaint();
    }
  }

  private handleAuthResult(r: ValidateResult): void {
    if (r.status === "ready") {
      this.mode = "loading";
      this.repaint();
      void this.loadList();
      return;
    }
    if (r.status === "login_required") {
      this.mode = "login";
      this.form = new LoginForm();
      this.repaint();
      return;
    }
    this.mode = "login";
    if (r.message) this.form.setMessage(r.message);
    this.repaint();
  }

  private async loadList(): Promise<void> {
    try {
      const r = (await this.opts.client.request("media/list", undefined)) as MediaList;
      this.items = r.items;
      this.selected = 0;
      this.mode = "list";
      this.repaint();
    } catch {
      this.mode = "login";
      this.form.setMessage("failed to load reels");
      this.repaint();
    }
  }

  private repaint(): void {
    if (!this.pane) return;
    if (this.mode === "loading") {
      this.pane.setLines(["instagram (reels): loading…"]);
      return;
    }
    if (this.mode === "login") {
      const lines = ["[ Instagram login ]", "", ...this.form.renderLines(this.pane.cols)];
      this.pane.setLines(lines);
      return;
    }
    const lines: string[] = ["[ Reels ]", ""];
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (!item) continue;
      const marker = i === this.selected ? "▸ " : "  ";
      lines.push(`${marker}${item.caption.slice(0, this.pane.cols - 4) || "(no caption)"}`);
    }
    if (this.items.length === 0) lines.push("  (no reels)");
    lines.push("", "Enter: open in carbonyl   j/k: scroll   q: close");
    this.pane.setLines(lines);
  }
}
```

- [x] **Step 4: Run, verify pass**

```bash
pnpm --filter @aether/limbo-host test -- reels-adapter
```

Expected: 5 tests pass.

- [x] **Step 5: Stage**

```bash
git add packages/host/src/adapters/instagram/reels-adapter.ts packages/host/src/adapters/instagram/reels-adapter.test.ts
```

Ready to commit: `feat(host): add InstagramReelsAdapter with login form and media list`

---

## Task 7: Wire `Enter` from overlay to adapter

**Goal:** The overlay keymap doesn't have `Enter` today. Add `KeyAction { kind: "enter" }`, route it from the overlay's `applyAction` to the active adapter via a new optional `IAdapter.onEnter?()` hook.

**Files:**
- Modify: `packages/host/src/overlay/types.ts` — add `enter` action
- Modify: `packages/host/src/overlay/keymap.ts` — emit `enter` on `\r` or `\n`
- Modify: `packages/host/src/adapters/types.ts` — add `IAdapter.onEnter?(): void`
- Modify: `packages/host/src/overlay/overlay.ts` — route enter to mounted adapter
- Test: `packages/host/src/overlay/keymap.test.ts` (extend)
- Test: `packages/host/src/overlay/overlay.test.ts` (extend)

- [x] **Step 1: Failing test in keymap.test.ts**

```typescript
it("emits {kind:'enter'} on \\r and on \\n", () => {
  const k = new OverlayKeymap();
  expect(k.feed("\r")).toEqual([{ kind: "enter" }]);
  expect(k.feed("\n")).toEqual([{ kind: "enter" }]);
});
```

- [x] **Step 2: Failing test in overlay.test.ts**

```typescript
it("routes Enter to the mounted adapter's onEnter", async () => {
  const onEnter = vi.fn();
  const fake: IAdapter = {
    id: "ig",
    mount: async () => undefined,
    unmount: async () => undefined,
    handleKey: () => undefined,
    onEnter,
  };
  const registry: IAdapterRegistry = { get: () => fake, list: () => [] };
  const stdout = makeStdout();
  const detector = new FakeDetector("idle");
  const overlay = new LimboOverlay({
    stdout, detector, registry,
    tabs: [{ id: "reels", label: "Reels", placeholderRef: "§4.7", adapterId: "ig" }],
  });
  overlay.open();
  await Promise.resolve();
  overlay.handleInput("\r");
  expect(onEnter).toHaveBeenCalledOnce();
});
```

- [x] **Step 3: Verify failures**

```bash
pnpm --filter @aether/limbo-host test -- "(keymap|overlay)"
```

- [x] **Step 4: Implement**

In `overlay/types.ts`, add `| { kind: "enter" }` to `KeyAction`.

In `overlay/keymap.ts`, before the `switch (ch)`, add:
```typescript
if (ch === "\r" || ch === "\n") { actions.push({ kind: "enter" }); continue; }
```

In `adapters/types.ts`, add to `IAdapter`:
```typescript
onEnter?(): void;
```

In `overlay/overlay.ts`, in `applyAction`, add:
```typescript
case "enter":
  this.mounted?.adapter.onEnter?.();
  return false;
```
And update the keymap-routing branch in `handleInput` so `enter` does not fall into the `scroll-*` branch.

- [x] **Step 5: Run, verify pass**

```bash
pnpm --filter @aether/limbo-host test -- "(keymap|overlay)"
```

- [x] **Step 6: Stage**

```bash
git add packages/host/src/overlay/types.ts packages/host/src/overlay/keymap.ts packages/host/src/overlay/keymap.test.ts packages/host/src/adapters/types.ts packages/host/src/overlay/overlay.ts packages/host/src/overlay/overlay.test.ts
```

Ready to commit: `feat(overlay): add Enter key action and IAdapter.onEnter hook`

---

## Task 8: Feed sidecar + adapter (text-only)

**Goal:** The Feed view ships text-only — caption + author + media URL, scrollable. No thumbnails (D11 stays deferred). Mirrors Reels but calls `client.get_timeline_feed()`.

**Files:**
- Create: `packages/sidecars/src/limbo_sidecars/instagram/feed.py`
- Create: `packages/sidecars/tests/test_feed_handlers.py`
- Create: `packages/host/src/adapters/instagram/feed-adapter.ts`
- Create: `packages/host/src/adapters/instagram/feed-adapter.test.ts`

- [x] **Step 1: Failing pytest for `feed/list` handler**

```python
# packages/sidecars/tests/test_feed_handlers.py
from __future__ import annotations
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from limbo_sidecars.instagram.feed import build_handlers
from limbo_sidecars.instagram.session import IGSession


class TwoFactor(Exception): pass

class FakeClient:
    def load_settings(self, path: Path) -> None: ...
    def dump_settings(self, path: Path) -> None: ...
    def login(self, *_a: Any, **_k: Any) -> bool: return True
    def get_timeline_feed(self) -> Any: return {}
    def user_feed(self, **_k: Any) -> list[Any]:
        return [
            SimpleNamespace(
                pk="1",
                code="aaa",
                caption_text="hello world",
                user=SimpleNamespace(username="alice"),
                media_type=1,
            ),
        ]


def test_feed_list_returns_serialized_items(tmp_path: Path) -> None:
    sess_path = tmp_path / "instagram.json"
    sess_path.write_text("{}")
    sess = IGSession(client=FakeClient(), session_path=sess_path, two_factor_exc=TwoFactor)
    h = build_handlers(sess)
    out = h["feed/list"](None)
    assert out == {"items": [{
        "pk": "1",
        "code": "aaa",
        "author": "alice",
        "caption": "hello world",
        "url": "https://www.instagram.com/p/aaa/",
    }]}
```

- [x] **Step 2: Implement `feed.py`**

Mirror `reels.py`. The list handler is `feed/list` and pulls from `client.user_feed(...)`. **Cross-check with context7 instagrapi for the actual feed-loading method name** — there is `get_timeline_feed()` (low-level, returns the raw JSON) and adapter helpers; pick whichever returns post objects with `code`, `caption_text`, `user.username`. Adjust the handler to suit.

Write the handler and main analogously to `reels.py`.

- [x] **Step 3: TS-side `InstagramFeedAdapter`**

Mirror `InstagramReelsAdapter`. Differences:
- Method names: `feed/list` instead of `media/list`.
- Each item's render line is `@author: caption (url)`.
- `onEnter` opens `runDetached(item.url)` exactly as Reels.

Write the failing test, run, implement, run again.

- [x] **Step 4: Run all touched tests**

```bash
cd packages/sidecars && PYTHONPATH=src python -m pytest tests/test_feed_handlers.py -v
pnpm --filter @aether/limbo-host test -- feed-adapter
```

- [x] **Step 5: Stage**

```bash
git add packages/sidecars/src/limbo_sidecars/instagram/feed.py packages/sidecars/tests/test_feed_handlers.py packages/host/src/adapters/instagram/feed-adapter.ts packages/host/src/adapters/instagram/feed-adapter.test.ts
```

Ready to commit: `feat(sidecars,host): add instagram feed adapter (text-only)`

---

## Task 9: DMs sidecar + adapter (read + send-reply)

**Goal:** Two screens — thread list and thread detail — plus a reply input mode. Reply hits `direct_send(text, thread_ids=[id])`. Input mode toggled by `i` (vim-ish) when in thread detail; Esc returns to nav.

**Files:**
- Create: `packages/sidecars/src/limbo_sidecars/instagram/dms.py`
- Create: `packages/sidecars/tests/test_dms_handlers.py`
- Create: `packages/host/src/adapters/instagram/dms-adapter.ts`
- Create: `packages/host/src/adapters/instagram/dms-adapter.test.ts`

**RPC methods exposed by the sidecar:**

| method | params | result |
|---|---|---|
| `validate` | none | `{status, message}` |
| `login` | `{username, password}` | `{status, message}` |
| `login_2fa` | `{code}` | `{status, message}` |
| `dms/threads` | none | `{items: [{thread_id, title, last_message}]}` |
| `dms/messages` | `{thread_id}` | `{items: [{from, text, ts}]}` |
| `dms/send` | `{thread_id, text}` | `{ok: bool, message: string \| null}` |

- [x] **Step 1: pytest** — verify each handler with a fake client (mirrors `reels` / `feed` test shape). **Cross-check method names with context7 instagrapi** (`direct_threads`, `direct_messages`, `direct_send`).

- [x] **Step 2: Implement `dms.py`** — mirror `reels.py`'s skeleton, adding a thread cache so `dms/messages` can resolve the thread id to a thread object if instagrapi requires the object form.

- [x] **Step 3: Failing TS test** — verify mode transitions (list → detail → input → send) and that `captureInput` is true only in input mode.

- [x] **Step 4: Implement `InstagramDmsAdapter`** with three modes: `"threads"`, `"messages"`, `"input"`. Key bindings inside the adapter (handled via `handleKey` for nav and `captureInput` for input mode):
  - `threads` mode: `j/k` move selection, Enter → load `dms/messages`, switch to `messages`.
  - `messages` mode: `j/k` scroll, `i` → switch to `input` (set internal `inputBuffer = ""`), Esc → back to `threads`.
  - `input` mode: `captureInput` returns `true` and accumulates printable chars; backspace deletes; Enter dispatches `dms/send` and switches back to `messages` on success.

- [x] **Step 5: Run all DM tests**

```bash
cd packages/sidecars && PYTHONPATH=src python -m pytest tests/test_dms_handlers.py -v
pnpm --filter @aether/limbo-host test -- dms-adapter
```

- [x] **Step 6: Stage**

```bash
git add packages/sidecars/src/limbo_sidecars/instagram/dms.py packages/sidecars/tests/test_dms_handlers.py packages/host/src/adapters/instagram/dms-adapter.ts packages/host/src/adapters/instagram/dms-adapter.test.ts
```

Ready to commit: `feat(sidecars,host): add instagram dms adapter with reply input mode`

---

## Task 10: Wire all three Instagram adapters into the wrapper registry

**Goal:** Replace the placeholder tabs in `DEFAULT_TABS` with adapter-bound tabs (Reels → `instagram-reels`, Feed → `instagram-feed`, DMs → `instagram-dms`). Register descriptors in `defaultRegistry()` with `extras: ["instagram"]` so the venv bootstrap exercises the real install path (D13).

**Files:**
- Modify: `packages/host/src/overlay/types.ts` — add `adapterId` to existing tabs
- Modify: `packages/host/src/wrapper.ts` — register descriptors + carbonyl bin resolution
- Test: `packages/host/src/wrapper.test.ts` (extend with a mounted-tab assertion using a fake registry)

- [x] **Step 1: Update `DEFAULT_TABS`**

```typescript
// overlay/types.ts
export const DEFAULT_TABS: readonly TabDefinition[] = [
  { id: "reels", label: "Reels", placeholderRef: "§4.7", adapterId: "instagram-reels" },
  { id: "feed", label: "Feed", placeholderRef: "§4.7", adapterId: "instagram-feed" },
  { id: "dms", label: "DMs", placeholderRef: "§4.7", adapterId: "instagram-dms" },
  { id: "x", label: "X", placeholderRef: "§4.8" },
  { id: "tiktok", label: "TikTok", placeholderRef: "§4.9" },
];
```

- [x] **Step 2: Update `defaultRegistry` in `wrapper.ts`**

```typescript
function defaultRegistry(opts: { env: NodeJS.ProcessEnv; cwd: string }): IAdapterRegistry {
  const makeIg = (id: string, sidecarName: string) => ({
    id,
    extras: ["instagram"],
    enabled: true,
    create: (): IAdapter => {
      const transport = new ChildProcessTransport({
        pythonExe: "python3",
        args: ["-m", "limbo_sidecars", sidecarName],
        env: opts.env,
        cwd: opts.cwd,
        spawn: nodeSpawn,
      });
      const client = new JsonRpcClient(transport);
      const carbonylBin = opts.env.LIMBO_CARBONYL_BIN ?? "carbonyl";
      // Resolve overlay lazily through a closure variable that wrapper.ts
      // populates after constructing the overlay (chicken-and-egg avoidance).
      // See OVERLAY_REF below.
      const runDetached = (url: string) =>
        OVERLAY_REF.current
          ? import("./adapters/carbonyl.js").then(({ runDetached: r }) =>
              r({ url, overlay: OVERLAY_REF.current!, spawn: nodeSpawn, carbonylBin }),
            )
          : Promise.resolve();
      if (id === "instagram-reels") return new InstagramReelsAdapter({ client, runDetached });
      if (id === "instagram-feed") return new InstagramFeedAdapter({ client, runDetached });
      return new InstagramDmsAdapter({ client });
    },
  });
  const echoDescriptor: AdapterDescriptor = { /* unchanged */ };
  return new BuiltinAdapterRegistry([
    makeIg("instagram-reels", "instagram-reels"),
    makeIg("instagram-feed", "instagram-feed"),
    makeIg("instagram-dms", "instagram-dms"),
    echoDescriptor,
  ]);
}
```

`OVERLAY_REF` is a `{ current: IOverlayController | undefined }` closure-scoped object the wrapper assigns after constructing the overlay. The closure-via-mutable-cell is the cleanest workaround for the registry-needs-overlay-needs-registry cycle.

- [x] **Step 3: Failing wrapper test**

```typescript
it("registers instagram-reels/feed/dms adapters with extras=['instagram']", () => {
  const registry = makeDefaultRegistryForTest();
  const ids = registry.list().map((d) => d.id);
  expect(ids).toContain("instagram-reels");
  expect(ids).toContain("instagram-feed");
  expect(ids).toContain("instagram-dms");
  for (const d of registry.list()) {
    if (d.id.startsWith("instagram-")) expect(d.extras).toEqual(["instagram"]);
  }
});
```

(Expose `defaultRegistry` for testing if it isn't exported — guard the test export with `// @internal`.)

- [x] **Step 4: Run, verify pass**

```bash
pnpm --filter @aether/limbo-host test -- wrapper
```

- [x] **Step 5: Stage**

```bash
git add packages/host/src/overlay/types.ts packages/host/src/wrapper.ts packages/host/src/wrapper.test.ts
```

Ready to commit: `feat(host): wire instagram adapters into default registry with carbonyl detach`

---

## Task 11: Update PLAN.md

**Goal:** Check off the four §4.7 bullets, add §4.7 deferrals to the §5.1 deferred-work table.

**Files:**
- Modify: `PLAN.md`

- [x] **Step 1: Check off §4.7**

Replace the four `- [ ]` lines under §4.7 with `- [x]` and append a one-paragraph "done" note describing where each capability lives (matches the §4.6 commit-message style).

- [x] **Step 2: Append D15-D19 to §5.1 deferred-work table**

| # | Item | Origin | Target section | Blocked on | Rationale |
|---|------|--------|----------------|------------|-----------|
| D15 | Sixel/kitty thumbnail rendering for the Feed view | §4.7 | §4.7.x patch | An adapter actually demanding image rendering AND a `IPane.write(bytes)` API | Feed ships text-only with `@author: caption (url)`. To paint thumbnails we need (1) terminal-capability detection (kitty graphics protocol vs sixel vs none), (2) image bytes streamed from the sidecar, and (3) `IPane.write(bytes)` for raw SGR/sixel passthrough with bounds enforcement. Subsumes the §4.6 D11 row from the angle of "image rendering"; D11 stays open for the more general "sub-pane host" case. |
| D16 | True sub-pane carbonyl host (no overlay teardown round-trip) | §4.7 | §4.7.x or §4.9 | A user reporting the close-and-reopen UX is too jarring | Reels' `Enter→carbonyl` ships via `runDetached`: closes overlay, restores main screen, runs carbonyl with inherited stdio, re-opens overlay on exit. A true sub-pane host would split the body region into a pty-rendering sub-rect — significantly more code (PTY split-screen, carbonyl resize forwarding, dual-cursor management). Keeps D2 open. |
| D17 | Instagram session sharing across the three tabs (one client process, three views) | §4.7 | §4.11 (`[adapters]` keep-warm) | Performance complaint that spawning per tab is too slow | Today each of `instagram-reels`/`-feed`/`-dms` spawns its own `instagrapi.Client` and re-runs `load_settings` + a smoke check. Cold spawn is ~200ms; warm is ~50ms. Sharing would require either (a) an instagram-specific daemon process owned by the wrapper, or (b) the registry growing a `keep_warm` flag per descriptor (ties into §4.6 D12). |
| D18 | Credentials sourced from `~/.config/aether-limbo/secrets.toml` (env-var fallback exists today via `LIMBO_IG_USERNAME`) | §4.7 | §4.11 (config layer) | Config layer existing | The login form is the current source of credentials — works fine but requires retyping if the session JSON expires. A config-loaded TOML with restricted file mode (0600) would let the user opt into "remember me". OS keyring integration is the next step beyond that. |
| D19 | Sidecar progress notifications during `instagram extras` venv bootstrap | §4.7 | §4.6 / §4.11 | First-run UX feedback | `VenvBootstrap.onProgress` already paints to a callback; the wrapper needs to wire that callback into the overlay body so the user sees `installing instagrapi…` instead of an apparent freeze on first ever Reels open. D13 is "exercised" as soon as someone hits Reels; D19 is the UX polish. |

Mark D13 row's status: change "Blocked on: The first real adapter" to "**Resolved as of §4.7** — `instagram` extra installs on first Reels/Feed/DMs open."

Mark D11 row: append "Partially superseded by D15 (rich rendering for thumbnails); D11 itself stays open for the broader sub-pane case."

- [x] **Step 3: Stage**

```bash
git add PLAN.md
```

Ready to commit: `docs(plan): mark §4.7 done; record D15-D19 in §5.1 deferred-work table`

---

## Task 12: Verification pass

**Goal:** Run the entire host test suite and the opt-in Python contract test if `python3` + `instagrapi` happen to be installed locally. Report numbers.

- [x] **Step 1: Full host test run**

```bash
pnpm --filter @aether/limbo-host test
```

Report the pass count. The §4.6 baseline was 194 passing + 2 skipped — §4.7 should add ≥30 new tests (3 per adapter × 5-7 cases each + login form + carbonyl + overlay extensions).

- [x] **Step 2: Optional Python contract test (if env permits)**

```bash
LIMBO_RUN_PYTHON_TESTS=1 pnpm --filter @aether/limbo-host test -- adapter-roundtrip
```

If `instagrapi` is not installed in the test environment, this step is skipped; document the skip.

- [x] **Step 3: Manual one-shot smoke (if `claude` and an IG account are available)**

```bash
limbo
# Press Ctrl+L while a long Claude prompt is processing
# Tab to "Reels", complete login, scroll, press Enter on a reel
# Verify carbonyl opens, exits, overlay re-opens
# Tab to "DMs", press Enter on a thread, press 'i', type a message, press Enter to send
```

This is the §4.13 manual verification entry — record outcomes in PLAN.md if performed.

---

## Self-review (run before handing the plan off)

- **Spec coverage:** Each of the four §4.7 bullets maps to a specific task (login → 3+4+6+9; reels → 5+6; feed → 8; dms → 9). Carbonyl integration → 2+6.
- **Placeholder scan:** No "TBD" / "implement later" remain. Every step has either code or a concrete command.
- **Type consistency:** `LoginAction` shape matches between `LoginForm` (Task 3) and the adapters that consume it (Tasks 6/9). `ValidateResult` matches `LoginResult` serialization in `_result_to_dict`. `IAdapter.captureInput?` signature matches between `types.ts` (Task 1), the overlay router (Task 1), and every adapter that implements it (Tasks 6/8/9).
- **Sidecar dispatch:** every name added to `__main__.py` (Task 5) corresponds to an adapter id registered in `wrapper.ts` (Task 10).
- **Deferral integrity:** D2/D11 stay open; D13 closes; new D15-D19 added. The plan is honest about what does NOT ship.

---

## Pickup ordering & parallelism notes

Tasks 1, 2, and 3 are independent — can be implemented in parallel by separate subagents.

Tasks 4 (Python session) is a prerequisite for 5 (reels.py) and 8 (feed.py) and 9 (dms.py).

Task 7 (Enter routing) is a prerequisite for 6/8/9's `onEnter` calls in tests.

Task 10 (wrapper wiring) requires 6, 8, 9 to exist.

Tasks 11 and 12 are sequential cleanups at the end.

Suggested execution order for subagent-driven mode:
**1 → 2 → 3 (parallel-OK) → 4 → 5 → 7 → 6 → 8 → 9 → 10 → 11 → 12.**
