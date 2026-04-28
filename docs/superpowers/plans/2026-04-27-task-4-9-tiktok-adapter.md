# §4.9 TikTok adapter (`TikTokApi`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the third real adapter — TikTok For-You feed driven by `TikTokApi`. The host paints an in-overlay paste form for the `ms_token` cookie (TikTokApi's auth handle), the sidecar fetches the personalised For-You feed via `api.user.feed()`, and `Enter` on a video opens it in a **true sub-pane carbonyl host** that splits the body region into a UI half and a carbonyl-PTY half — consuming the §4.5 / §4.7 carry-over.

**User decisions (locked before drafting):**

| # | Question | Answer |
|---|---|---|
| 1 | Auth model | In-overlay paste form for `ms_token` |
| 2 | Feed source | `api.user.feed()` (personalised) |
| 3 | Comments UX | `c` from feed → comments mode (`Esc` returns) |
| 4 | Carry-overs | Attempt true sub-pane carbonyl now (consume §4.5/§4.7 carry-over) |

**Architecture:**

- **One sidecar** (`tiktok-foryou`), spawned lazily by `BuiltinAdapterRegistry`, persists the `ms_token` to `~/.local/share/aether-limbo/sessions/tiktok.json` at mode `0600`.
- **Auth flow:** `validate` reads the session file → if missing, host paints `TokenForm` (single-field paste form); on submit, the host fires `set_token` RPC, sidecar persists & creates a `TikTokApi` session, returns `{status:"ready"}` or `{status:"failed", message}`.
- **Feed:** `feed/list` returns `{items: [{id, author, caption, url}, …]}`. `Enter` mounts a `CarbonylSubpane` in the lower half of the body region with `https://www.tiktok.com/@<author>/video/<id>` and the adapter switches to `playing` mode.
- **Comments:** `c` while a video is selected fires `feed/comments({video_id})` → renders `{from, text}` rows in `comments` mode. `Esc` returns to feed.
- **Sub-pane carbonyl:** new helper `CarbonylSubpane` spawns carbonyl in a sized PTY child via the existing `PtyFactory`, rewrites cursor-positioning ANSI sequences (`CSI r;c H`, `CSI r;c f`, `CSI r d`, bare `CSI H`, `CSI 2J`) so they land in the sub-rect, brackets each chunk with `\x1b[s`/`\x1b[u`, forwards SIGWINCH-driven resize.

**Tech stack additions:**

- `TikTokApi>=7.1.0` and `playwright>=1.47.0` (already declared in `pyproject.toml` as the `tiktok` extra).
- No new TS deps — reuses `node-pty` `PtyFactory`, `ChildProcessTransport`, `JsonRpcClient`, `runDetached`'s spawn typing.

---

## File structure

### Host package — TypeScript (new)

```
packages/host/src/adapters/tiktok/
├── token-form.ts                # TokenForm — single-field paste form
├── token-form.test.ts
├── foryou-adapter.ts            # TikTokForYouAdapter — modes: loading|token|feed|comments|playing
└── foryou-adapter.test.ts

packages/host/src/adapters/carbonyl-subpane.ts        # sub-pane carbonyl host
packages/host/src/adapters/carbonyl-subpane.test.ts
```

### Host package — TypeScript (modified)

```
packages/host/src/adapters/types.ts        # IPane.writeRaw?(bytes: string): void
packages/host/src/adapters/pane.ts         # OverlayPane.writeRaw — bounded raw passthrough
packages/host/src/wrapper.ts               # register tiktok-foryou descriptor with extras: ["tiktok"]
packages/host/src/overlay/types.ts         # bind tiktok tab to adapterId: "tiktok-foryou"
```

### Python sidecar (new)

```
packages/sidecars/src/limbo_sidecars/tiktok/
├── __init__.py
├── session.py                   # TikTokSession — load/save ms_token JSON, validate, set_token
└── foryou.py                    # python -m limbo_sidecars tiktok-foryou entrypoint

packages/sidecars/tests/test_tiktok_session.py
packages/sidecars/tests/test_tiktok_foryou_handlers.py
```

### Python sidecar (modified)

```
packages/sidecars/src/limbo_sidecars/__main__.py   # dispatch tiktok-foryou
```

### Plan-tracking artifact

- `PLAN.md` — tick §4.9 boxes, **delete the §4.5/§4.7 carry-over bullet that this task consumes**, record any new §4.9 deferrals as nested bullets *under* §4.9 per the project's deferral convention.

---

## Conventions to follow

- **TDD discipline.** Failing test before implementation. No "and tests for the above" cop-outs.
- **Imports.** ESM, `import type`, `.js` suffix on TS imports.
- **Strict null checks.** No `any`, no non-null assertions in new code.
- **Test seam.** `TikTokApi`'s `Client` is injected via constructor in `TikTokSession`. Unit tests pass a hand-rolled fake.
- **Secrets.** `ms_token` lives only in memory of the sidecar process and at mode `0600` on disk. Never echoed to host responses.
- **Subagent commit rule.** Stage but never commit on `main`. Parent commits.
- **Deferral rule.** Any v1-deferred item lands as a nested bullet under §4.9 in PLAN.md, never in a §5.x consolidation.

---

## Task 1: `IPane.writeRaw` — bounded raw-bytes pass-through

**Goal:** Extend the pane interface with an optional `writeRaw(bytes)` so `CarbonylSubpane` can pipe carbonyl output into the body without going through the line-buffered `setLines` path. Bounded — the pane is responsible for ensuring writes don't escape its region (cursor save/restore + initial positioning).

**Files:**
- Modify: `packages/host/src/adapters/types.ts`
- Modify: `packages/host/src/adapters/pane.ts`
- Test: `packages/host/src/adapters/pane.test.ts`

- [x] Step 1: Add `writeRaw?(bytes: string): void` to `IPane` in `types.ts`.
- [x] Step 2: Failing test in `pane.test.ts` — `writeRaw("hello")` brackets the output with `\x1b[s` and `\x1b[u` and writes the chunk verbatim between them.
- [x] Step 3: Implement on `OverlayPane`.
- [x] Step 4: Run `pnpm --filter @aether-limbo/host test -- pane`. Expect green.

## Task 2: `CarbonylSubpane` — sub-rect carbonyl host

**Goal:** Spawn carbonyl in a node-pty child sized to a sub-rect; rewrite absolute-cursor ANSI sequences so they land in the sub-rect; forward resize.

**Files:**
- New: `packages/host/src/adapters/carbonyl-subpane.ts`
- New: `packages/host/src/adapters/carbonyl-subpane.test.ts`

- [x] Step 1: `CarbonylSubpane` class — constructor `{stdout, ptyFactory, carbonylBin, top, left, cols, rows, env}`. Spawns carbonyl via `ptyFactory({file, args, env, cwd, cols, rows})`.
- [x] Step 2: Failing test — given a chunk `"\x1b[1;1H[carbonyl] hi\x1b[2;3H!"` and `top=10, left=5`, the bytes written to stdout begin with `\x1b[s\x1b[10;5H` (save+position), contain the rewritten cursor moves `\x1b[10;5H` and `\x1b[11;7H`, and end with `\x1b[u` (restore).
- [x] Step 3: Implement `relayChunk(chunk)` — regex-rewrite `CSI <r>;<c> [Hf]`, `CSI <r> d`, bare `CSI H`, `CSI 2J`; bracket with `\x1b[s` / `\x1b[u`; prepend initial cursor-set when chunk lacks an absolute position.
- [x] Step 4: Failing test — `resize(cols, rows)` calls `pty.resize(cols, rows)`.
- [x] Step 5: Failing test — `kill()` calls `pty.kill('SIGTERM')` and clears the sub-rect with spaces.
- [x] Step 6: Failing test — `onExit(handler)` fires when the child PTY exits.
- [x] Step 7: Run `pnpm --filter @aether-limbo/host test -- carbonyl-subpane`. Expect green.

## Task 3: `TokenForm` — single-field paste form

**Goal:** State machine for the in-overlay `ms_token` paste form. Mirrors `LoginForm` but with one field and no 2FA branch.

**Files:**
- New: `packages/host/src/adapters/tiktok/token-form.ts`
- New: `packages/host/src/adapters/tiktok/token-form.test.ts`

- [x] Step 1: Failing test — `feed("eyJ…")` accumulates into the `token` buffer; `feed("\r")` returns `{kind:"submit", payload:{ms_token:"eyJ…"}}`; `\x7f` deletes; `\x1b` cancels (returns `{kind:"cancel"}`).
- [x] Step 2: Failing test — printable chars 0x20-0x7e accepted; control bytes ignored; `renderLines(cols)` shows `[ TikTok session ]`, `Paste ms_token cookie:`, the masked input (last 4 chars visible, rest as `*`), and `Enter: submit   Esc: cancel`.
- [x] Step 3: Implement `TokenForm`.
- [x] Step 4: Run `pnpm --filter @aether-limbo/host test -- token-form`. Expect green.

## Task 4: `TikTokSession` (Python)

**Goal:** Thin wrapper around an injected `TikTokApi` instance. Persist/load `ms_token` to `~/.local/share/aether-limbo/sessions/tiktok.json` at mode `0600`.

**Files:**
- New: `packages/sidecars/src/limbo_sidecars/tiktok/__init__.py` (empty)
- New: `packages/sidecars/src/limbo_sidecars/tiktok/session.py`
- New: `packages/sidecars/tests/test_tiktok_session.py`

- [x] Step 1: Failing test — `validate()` returns `LoginResult("login_required", None)` when the session file is absent.
- [x] Step 2: Failing test — `validate()` after `set_token("eyJ…")` returns `("ready", None)` and the file has been written at mode `0600` with `{"ms_token":"eyJ…"}`.
- [x] Step 3: Failing test — `set_token` calls `api.create_sessions(ms_tokens=["eyJ…"], num_sessions=1)` exactly once.
- [x] Step 4: Implement `TikTokSession` mirroring `TwitterSession`'s shape (`runner` for asyncio, `client` accessor, persisted-cookie path).
- [x] Step 5: Run `pytest packages/sidecars/tests/test_tiktok_session.py`. Expect green.

## Task 5: `tiktok-foryou` sidecar handlers + dispatcher

**Goal:** Implement `validate`, `set_token`, `feed/list`, `feed/comments`. Plug into `__main__.py`.

**Files:**
- New: `packages/sidecars/src/limbo_sidecars/tiktok/foryou.py`
- New: `packages/sidecars/tests/test_tiktok_foryou_handlers.py`
- Modify: `packages/sidecars/src/limbo_sidecars/__main__.py`

- [x] Step 1: Failing test — `validate` round-trips `LoginResult` from session.
- [x] Step 2: Failing test — `set_token({"ms_token":"x"})` calls `session.set_token` and returns `LoginResult` payload.
- [x] Step 3: Failing test — `feed/list` calls `api.user.feed()` (async iterator), serialises top N to `{items: [{id, author, caption, url}]}` with URL `https://www.tiktok.com/@<author>/video/<id>`.
- [x] Step 4: Failing test — `feed/comments({video_id})` calls `api.video(id).comments()`, serialises to `{items: [{from, text}]}`. On any exception → `{available:false, items:[], message:str(err)}` (degrade pattern matches §4.8 DMs).
- [x] Step 5: Implement `build_handlers(session, runner=asyncio.run, count=20)`.
- [x] Step 6: Implement `main()` mirroring `twitter.home.main` — instantiate real `TikTokApi`, call `session.validate()`, notify `body/update`, serve.
- [x] Step 7: Add `tiktok-foryou` to `__main__.py` dispatcher.
- [x] Step 8: Run `pytest packages/sidecars/tests/test_tiktok_foryou_handlers.py`. Expect green.

## Task 6: `TikTokForYouAdapter` (host TS)

**Goal:** The adapter that ties it all together. Five modes: `loading | token | feed | comments | playing`.

**Files:**
- New: `packages/host/src/adapters/tiktok/foryou-adapter.ts`
- New: `packages/host/src/adapters/tiktok/foryou-adapter.test.ts`

- [x] Step 1: Failing test — mount → `validate` → `ready` → `feed/list` → renders `@author: caption` rows.
- [x] Step 2: Failing test — `validate` → `login_required` → `token` mode → `captureInput` returns `true` → submit fires `set_token` RPC → on `ready` switch to feed loading.
- [x] Step 3: Failing test — `j/k` scroll selection (via `handleKey({kind:"scroll-down"})`).
- [x] Step 4: Failing test — `c` from feed → `feed/comments({video_id: selected.id})` → switch to comments mode and render `<from> text` rows. `Esc` returns to feed.
- [x] Step 5: Failing test — `onEnter` from feed → `runSubPane(url, paneRect)` factory called with the canonical `https://www.tiktok.com/@<author>/video/<id>`.
- [x] Step 6: Failing test — when in `playing` mode, `q` (or any close key path) calls `subpane.kill()` and the adapter switches back to feed.
- [x] Step 7: Implement `TikTokForYouAdapter` (constructor takes `{client, runSubPane}` factory).
- [x] Step 8: Run `pnpm --filter @aether-limbo/host test -- tiktok`. Expect green.

## Task 7: Wire-up — wrapper.ts, overlay/types.ts, registry

**Goal:** Register the adapter, bind the TikTok tab.

**Files:**
- Modify: `packages/host/src/wrapper.ts`
- Modify: `packages/host/src/overlay/types.ts`

- [x] Step 1: Add `tiktok-foryou` `AdapterDescriptor` in `defaultRegistry()` with `extras: ["tiktok"]`. Construct a `runSubPane` factory closure that captures the `ptyFactory` from `runWrapper` (added to `defaultRegistry` opts).
- [x] Step 2: Set the TikTok tab `adapterId: "tiktok-foryou"` in `DEFAULT_TABS`.
- [x] Step 3: Run `pnpm --filter @aether-limbo/host test`. Full host suite green.
- [x] Step 4: Run `pnpm --filter @aether-limbo/host build` to confirm tsup builds clean.

## Task 8: PLAN.md updates + deferral consumption

**Goal:** Tick §4.9 boxes; **delete** the consumed sub-pane carry-over bullet from §4.9 (we're shipping it); record any *new* §4.9 deferrals as nested bullets under §4.9.

**Files:**
- Modify: `/Users/arnavmarda/Desktop/Dev/aether-limbo/PLAN.md`

- [x] Step 1: Tick the four `- [ ]` items in §4.9.
- [x] Step 2: **Delete** the §4.5 / §4.7 sub-pane carry-over bullet (consumed by Task 2).
- [x] Step 3: Update or **delete** the §4.6 pane-API carry-over bullet — the video-rendering case lands here. Keep the image-rendering case at §4.11. Rewrite the bullet to reflect that.
- [x] Step 4: If any v1 sub-feature was deferred during execution (e.g. tweepy-style fallback paths, image rendering, secret-key persistence beyond ms_token), record each as a nested bullet under §4.9 — per the deferral rule, never under a §5.x consolidation.

## Task 9: Verification

- [x] Step 1: `pnpm --filter @aether-limbo/host typecheck` clean.
- [x] Step 2: `pnpm --filter @aether-limbo/host lint` clean.
- [x] Step 3: `pnpm --filter @aether-limbo/host test` — all tests pass.
- [x] Step 4: `pytest packages/sidecars/tests` — all tests pass.
- [x] Step 5: Cross-check (paper): the §4.9 four bullets all map to checked work in the diff.

---

## Risks called out before coding

- **Sub-pane carbonyl correctness.** Carbonyl uses absolute-cursor ANSI; the rewriter handles the common cases (CUP, HVP, VPA, ED) but not every escape. If carbonyl issues a sequence we don't rewrite, the worst-case bleed is a one-frame paint outside the sub-rect. Acceptable for v1; record as a §4.9 deferral if observed.
- **`api.user.feed()` shape.** `TikTokApi` has changed shape across major versions; the handler test uses a hand-rolled fake matching v7.1 conventions. Record `verify TikTokApi method names against a real account` under §4.13 (matches the precedent set for instagrapi/twikit).
- **`ms_token` rotation.** The cookie rotates server-side; on first 401-ish failure, surface the form again. v1: simple — any `feed/list` exception drops back to `token` mode with a message.
