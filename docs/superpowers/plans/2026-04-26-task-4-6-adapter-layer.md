# §4.6 Adapter Layer (Node ↔ Python sidecars) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Node ↔ Python sidecar layer (adapter contract, JSON-RPC 2.0 transport, lazy-spawn lifecycle, lazy venv bootstrap, per-adapter feature flag) and prove the wire format end-to-end with a built-in `echo` Python sidecar mounted on a hidden debug tab.

**Architecture:** Each `Adapter` is mounted into an `IPane` carved out of the overlay's body region. Adapters drive a `JsonRpcClient` over an injected `ITransport`; the production transport spawns `python -m limbo_sidecars <name>` and frames JSON-RPC 2.0 envelopes as NDJSON over stdio. Sidecars spawn lazily on tab activation and are killed when the overlay closes (or limbo exits). A `VenvBootstrap` step runs once before the first sidecar of a session, painting progress into the overlay body.

**Tech stack:**
- TypeScript strict / ESM (host side, vitest + biome)
- Python 3.11+ stdlib only for the JSON-RPC server (no third-party deps for §4.6)
- `node:child_process` (`spawn`) for the sidecar transport
- `node:crypto` for the requirements-hash manifest
- `node:fs/promises` for venv detection / manifest IO

**Decisions locked from the brainstorming step:**
- §4.6 scope: plumbing **plus** an `echo` demo adapter wired into a hidden `__echo` tab (gated by `LIMBO_DEBUG_ECHO=1`).
- RPC framing: **JSON-RPC 2.0 envelopes, one JSON object per line** on stdio (NDJSON).
- Sidecar lifecycle: **lazy** — spawn on tab activation, kill on overlay close.
- Bootstrap UX: **lazy** — install on first sidecar spawn, render progress in overlay body.

---

## File structure

### Host package — TypeScript (new files)

```
packages/host/src/adapters/
├── types.ts                       # IAdapter, IPane, AdapterDescriptor, IAdapterRegistry, lifecycle types
├── registry.ts                    # BuiltinAdapterRegistry (filters by feature flags)
├── registry.test.ts
├── pane.ts                        # OverlayPane — paints into body region, forwards resize
├── pane.test.ts
├── echo-adapter.ts                # EchoAdapter (TS-side) wired into the __echo tab
├── echo-adapter.test.ts
├── rpc/
│   ├── codec.ts                   # JSON-RPC 2.0 encode/decode + NDJSON framing
│   ├── codec.test.ts
│   ├── transport.ts               # ITransport interface
│   ├── client.ts                  # JsonRpcClient (request/notify/on, reply correlation)
│   └── client.test.ts
└── sidecar/
    ├── venv.ts                    # VenvBootstrap (detect / install / manifest)
    ├── venv.test.ts
    ├── child-transport.ts         # ChildProcessTransport (spawns python via child_process)
    └── child-transport.test.ts
```

### Host package — TypeScript (modified files)

```
packages/host/src/overlay/types.ts        # TabDefinition.adapterId?, OverlayDeps.registry?
packages/host/src/overlay/overlay.ts      # mount/unmount adapter on tab change; route scroll-* to active adapter
packages/host/src/wrapper.ts              # construct registry; conditionally append __echo tab when LIMBO_DEBUG_ECHO=1
packages/host/src/index.ts                # re-export adapter public types
```

### Python sidecar package (new files)

```
packages/sidecars/src/limbo_sidecars/
├── __main__.py                    # `python -m limbo_sidecars <name>` dispatch
├── jsonrpc.py                     # NDJSON-framed JSON-RPC 2.0 server loop (stdlib only)
└── echo.py                        # built-in echo adapter (no third-party deps)
```

### Python sidecar package (modified files)

```
packages/sidecars/pyproject.toml          # widen requires-python to <3.15; add `[project.scripts]`
```

### Test fixtures (new files)

```
packages/host/test/adapter-roundtrip.test.ts                       # opt-in real-python contract test
packages/host/test/fixtures/sidecars/echo-stub.mjs                 # in-process Node fake (for unit tests)
```

### Plan-tracking artifact

- `PLAN.md` — check off §4.6 bullets, append §4.6 deferrals to the §5.1 deferred-work table.

---

## Conventions to follow (read once before starting)

- **TDD discipline.** Every step that introduces production code is preceded by a failing test that exercises exactly the new behavior. No "write tests for the above" cop-outs.
- **Imports.** ESM, `import type` for type-only imports (biome rule), `.js` suffix in import paths even for `.ts` source.
- **Strict null checks.** No `any`, no non-null assertions (biome `style.noNonNullAssertion` is `warn`; treat as error).
- **Test seam.** Every external dependency (timers, streams, child_process) is injected through an interface so unit tests stay hermetic.
- **No code in `MEMORY.md` or session notes** — write the actual code in the file the test expects it in.
- **Commit cadence.** Commit after every passing test green. Conventional Commits: `feat(host): add adapter contract types`, `test(host): cover JSON-RPC NDJSON framing`, etc.
- **Verification before completion.** Each task ends with `pnpm --filter @aether/limbo-host test` (or the precise vitest filter) and reports the actual pass count, not a hand-wave.

---

## Task 1: Adapter contract types

**Goal:** Lock the public shapes (`IAdapter`, `IPane`, `AdapterDescriptor`, `IAdapterRegistry`) before any implementation exists. Pure types — no runtime behavior yet.

**Files:**
- Create: `packages/host/src/adapters/types.ts`
- Test: `packages/host/src/adapters/types.test.ts` (compile-time tests — assignability checks via `expectTypeOf`)

- [ ] **Step 1: Write the failing compile-time test**

```typescript
// packages/host/src/adapters/types.test.ts
import { describe, expectTypeOf, it } from "vitest";
import type { IDisposable } from "../pty/types.js";
import type { KeyAction } from "../overlay/types.js";
import type {
  AdapterDescriptor,
  AdapterLifecycleEvent,
  IAdapter,
  IAdapterRegistry,
  IPane,
} from "./types.js";

describe("adapter contract types", () => {
  it("IAdapter exposes id, mount, unmount, handleKey", () => {
    expectTypeOf<IAdapter["id"]>().toBeString();
    expectTypeOf<IAdapter["mount"]>().toBeFunction();
    expectTypeOf<IAdapter["unmount"]>().toBeFunction();
    expectTypeOf<IAdapter["handleKey"]>().parameters.toEqualTypeOf<[KeyAction]>();
  });

  it("IPane.setLines accepts readonly string[]", () => {
    expectTypeOf<IPane["setLines"]>().parameters.toEqualTypeOf<[readonly string[]]>();
  });

  it("IPane.on('resize') returns IDisposable", () => {
    expectTypeOf<ReturnType<IPane["on"]>>().toEqualTypeOf<IDisposable>();
  });

  it("AdapterDescriptor binds an adapter id to a factory + extras list", () => {
    expectTypeOf<AdapterDescriptor["id"]>().toBeString();
    expectTypeOf<AdapterDescriptor["extras"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<AdapterDescriptor["create"]>().toBeFunction();
    expectTypeOf<AdapterDescriptor["enabled"]>().toEqualTypeOf<boolean>();
  });

  it("IAdapterRegistry.get returns IAdapter | undefined", () => {
    expectTypeOf<IAdapterRegistry["get"]>().returns.toEqualTypeOf<IAdapter | undefined>();
  });

  it("AdapterLifecycleEvent enumerates the lifecycle states", () => {
    expectTypeOf<AdapterLifecycleEvent>().toEqualTypeOf<
      "mounting" | "mounted" | "unmounting" | "unmounted" | "errored"
    >();
  });
});
```

- [ ] **Step 2: Run the test, expect "Cannot find module './types.js'"**

```
pnpm --filter @aether/limbo-host exec vitest run src/adapters/types.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Create `packages/host/src/adapters/types.ts`**

```typescript
import type { KeyAction } from "../overlay/types.js";
import type { IDisposable } from "../pty/types.js";

export type AdapterLifecycleEvent =
  | "mounting"
  | "mounted"
  | "unmounting"
  | "unmounted"
  | "errored";

export interface IPane {
  readonly cols: number;
  readonly rows: number;
  setLines(lines: readonly string[]): void;
  on(event: "resize", listener: (cols: number, rows: number) => void): IDisposable;
}

export interface IAdapter {
  readonly id: string;
  mount(pane: IPane): Promise<void>;
  unmount(): Promise<void>;
  handleKey(action: KeyAction): void;
}

export interface AdapterDescriptor {
  readonly id: string;
  readonly extras: readonly string[];
  readonly enabled: boolean;
  create(): IAdapter;
}

export interface IAdapterRegistry {
  get(id: string): IAdapter | undefined;
  list(): readonly AdapterDescriptor[];
}
```

- [ ] **Step 4: Run the test, expect green**

```
pnpm --filter @aether/limbo-host exec vitest run src/adapters/types.test.ts
```

Expected: PASS (6 type-level assertions).

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/adapters/types.ts packages/host/src/adapters/types.test.ts
git commit -m "feat(host): introduce §4.6 adapter contract types"
```

---

## Task 2: JSON-RPC 2.0 codec (encode + decode + NDJSON framing)

**Goal:** Pure-function codec that encodes JSON-RPC 2.0 messages to NDJSON lines and decodes incoming line-buffered chunks into well-typed messages. No streams, no I/O.

**Files:**
- Create: `packages/host/src/adapters/rpc/codec.ts`
- Create: `packages/host/src/adapters/rpc/codec.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/host/src/adapters/rpc/codec.test.ts
import { describe, expect, it } from "vitest";
import {
  type JsonRpcMessage,
  encodeRequest,
  encodeNotification,
  encodeResponse,
  encodeError,
  NdjsonDecoder,
} from "./codec.js";

describe("JSON-RPC 2.0 encoders (NDJSON)", () => {
  it("encodes a request with id+method+params followed by a single \\n", () => {
    const out = encodeRequest({ id: 7, method: "ping", params: { x: 1 } });
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out)).toEqual({ jsonrpc: "2.0", id: 7, method: "ping", params: { x: 1 } });
  });

  it("encodes a notification (no id field)", () => {
    const out = encodeNotification({ method: "body/update", params: { lines: ["hi"] } });
    expect(JSON.parse(out)).toEqual({
      jsonrpc: "2.0",
      method: "body/update",
      params: { lines: ["hi"] },
    });
  });

  it("encodes a successful response", () => {
    const out = encodeResponse({ id: 7, result: { ok: true } });
    expect(JSON.parse(out)).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
  });

  it("encodes an error response with code+message", () => {
    const out = encodeError({ id: 7, code: -32601, message: "method not found" });
    expect(JSON.parse(out)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "method not found" },
    });
  });
});

describe("NdjsonDecoder", () => {
  it("decodes a single complete line", () => {
    const d = new NdjsonDecoder();
    const msgs = d.feed(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 })}\n`);
    expect(msgs).toEqual<JsonRpcMessage[]>([{ jsonrpc: "2.0", id: 1, result: 42 }]);
  });

  it("buffers partial lines across feed() calls", () => {
    const d = new NdjsonDecoder();
    expect(d.feed(`{"jsonrpc":"2.0","id":1,"resu`)).toEqual([]);
    expect(d.feed(`lt":42}\n`)).toEqual<JsonRpcMessage[]>([{ jsonrpc: "2.0", id: 1, result: 42 }]);
  });

  it("decodes multiple lines in one feed", () => {
    const d = new NdjsonDecoder();
    const a = JSON.stringify({ jsonrpc: "2.0", method: "x" });
    const b = JSON.stringify({ jsonrpc: "2.0", method: "y" });
    expect(d.feed(`${a}\n${b}\n`)).toHaveLength(2);
  });

  it("throws on malformed JSON instead of silently dropping", () => {
    const d = new NdjsonDecoder();
    expect(() => d.feed("not json\n")).toThrow(/JSON/);
  });

  it("rejects messages missing the jsonrpc:'2.0' tag", () => {
    const d = new NdjsonDecoder();
    expect(() => d.feed(`${JSON.stringify({ id: 1, result: 42 })}\n`)).toThrow(/jsonrpc/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```
pnpm --filter @aether/limbo-host exec vitest run src/adapters/rpc/codec.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `codec.ts`**

```typescript
// packages/host/src/adapters/rpc/codec.ts
export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly result: unknown;
}

export interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly error: JsonRpcErrorBody;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcErrorResponse;

export function encodeRequest(args: {
  id: number | string;
  method: string;
  params?: unknown;
}): string {
  const msg: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: args.id,
    method: args.method,
    ...(args.params !== undefined ? { params: args.params } : {}),
  };
  return `${JSON.stringify(msg)}\n`;
}

export function encodeNotification(args: { method: string; params?: unknown }): string {
  const msg: JsonRpcNotification = {
    jsonrpc: "2.0",
    method: args.method,
    ...(args.params !== undefined ? { params: args.params } : {}),
  };
  return `${JSON.stringify(msg)}\n`;
}

export function encodeResponse(args: { id: number | string; result: unknown }): string {
  const msg: JsonRpcSuccess = { jsonrpc: "2.0", id: args.id, result: args.result };
  return `${JSON.stringify(msg)}\n`;
}

export function encodeError(args: {
  id: number | string | null;
  code: number;
  message: string;
  data?: unknown;
}): string {
  const error: JsonRpcErrorBody = {
    code: args.code,
    message: args.message,
    ...(args.data !== undefined ? { data: args.data } : {}),
  };
  const msg: JsonRpcErrorResponse = { jsonrpc: "2.0", id: args.id, error };
  return `${JSON.stringify(msg)}\n`;
}

export class NdjsonDecoder {
  private buffer = "";

  feed(chunk: string): JsonRpcMessage[] {
    this.buffer += chunk;
    const out: JsonRpcMessage[] = [];
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim().length > 0) out.push(this.parse(line));
      nl = this.buffer.indexOf("\n");
    }
    return out;
  }

  private parse(line: string): JsonRpcMessage {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`NdjsonDecoder: invalid JSON (${(err as Error).message})`);
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      (parsed as { jsonrpc?: unknown }).jsonrpc !== "2.0"
    ) {
      throw new Error("NdjsonDecoder: missing jsonrpc:'2.0' tag");
    }
    return parsed as JsonRpcMessage;
  }
}
```

- [ ] **Step 4: Run, expect PASS**

```
pnpm --filter @aether/limbo-host exec vitest run src/adapters/rpc/codec.test.ts
```

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/adapters/rpc/codec.ts packages/host/src/adapters/rpc/codec.test.ts
git commit -m "feat(host): JSON-RPC 2.0 codec with NDJSON framing"
```

---

## Task 3: ITransport interface

**Goal:** Define the byte-stream contract that the JsonRpcClient consumes. No implementation yet — we'll have two implementations later (real `ChildProcessTransport` and an in-memory test fake).

**Files:**
- Create: `packages/host/src/adapters/rpc/transport.ts`

- [ ] **Step 1: Write the type-level test**

```typescript
// packages/host/src/adapters/rpc/transport.test.ts
import { describe, expectTypeOf, it } from "vitest";
import type { IDisposable } from "../../pty/types.js";
import type { ITransport } from "./transport.js";

describe("ITransport", () => {
  it("exposes write, onData, onExit, close", () => {
    expectTypeOf<ITransport["write"]>().parameters.toEqualTypeOf<[string]>();
    expectTypeOf<ITransport["onData"]>().returns.toEqualTypeOf<IDisposable>();
    expectTypeOf<ITransport["onExit"]>().returns.toEqualTypeOf<IDisposable>();
    expectTypeOf<ITransport["close"]>().returns.toEqualTypeOf<void>();
  });
});
```

- [ ] **Step 2: Run, expect FAIL (module missing)**

```
pnpm --filter @aether/limbo-host exec vitest run src/adapters/rpc/transport.test.ts
```

- [ ] **Step 3: Create `transport.ts`**

```typescript
// packages/host/src/adapters/rpc/transport.ts
import type { IDisposable } from "../../pty/types.js";

export interface TransportExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface ITransport {
  write(chunk: string): void;
  onData(listener: (chunk: string) => void): IDisposable;
  onExit(listener: (exit: TransportExit) => void): IDisposable;
  close(): void;
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/adapters/rpc/transport.ts packages/host/src/adapters/rpc/transport.test.ts
git commit -m "feat(host): ITransport interface for sidecar I/O"
```

---

## Task 4: JsonRpcClient (over an injected transport)

**Goal:** Bidirectional JSON-RPC client with promise-based request/reply, fire-and-forget notifications, and method-router for incoming notifications. Tested entirely against an in-memory fake transport.

**Files:**
- Create: `packages/host/src/adapters/rpc/client.ts`
- Create: `packages/host/src/adapters/rpc/client.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/host/src/adapters/rpc/client.test.ts
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { IDisposable } from "../../pty/types.js";
import { JsonRpcClient } from "./client.js";
import type { ITransport, TransportExit } from "./transport.js";

class FakeTransport implements ITransport {
  written: string[] = [];
  private dataListeners: Array<(c: string) => void> = [];
  private exitListeners: Array<(e: TransportExit) => void> = [];
  closed = false;

  write(chunk: string): void {
    this.written.push(chunk);
  }
  onData(l: (c: string) => void): IDisposable {
    this.dataListeners.push(l);
    return { dispose: () => undefined };
  }
  onExit(l: (e: TransportExit) => void): IDisposable {
    this.exitListeners.push(l);
    return { dispose: () => undefined };
  }
  close(): void {
    this.closed = true;
  }
  emit(chunk: string): void {
    for (const l of this.dataListeners) l(chunk);
  }
  emitExit(e: TransportExit): void {
    for (const l of this.exitListeners) l(e);
  }
}

describe("JsonRpcClient.request", () => {
  it("writes a request envelope and resolves on the matching response", async () => {
    const t = new FakeTransport();
    const c = new JsonRpcClient(t);
    const p = c.request("ping", { x: 1 });
    expect(t.written).toHaveLength(1);
    const wrote = JSON.parse(t.written[0] ?? "{}");
    expect(wrote.method).toBe("ping");
    expect(wrote.params).toEqual({ x: 1 });
    t.emit(`${JSON.stringify({ jsonrpc: "2.0", id: wrote.id, result: "pong" })}\n`);
    await expect(p).resolves.toBe("pong");
  });

  it("rejects when the response carries an error body", async () => {
    const t = new FakeTransport();
    const c = new JsonRpcClient(t);
    const p = c.request("missing", undefined);
    const id = JSON.parse(t.written[0] ?? "{}").id;
    t.emit(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "method not found" },
      })}\n`,
    );
    await expect(p).rejects.toMatchObject({ code: -32601, message: "method not found" });
  });

  it("rejects all in-flight requests when the transport exits", async () => {
    const t = new FakeTransport();
    const c = new JsonRpcClient(t);
    const a = c.request("a", undefined);
    const b = c.request("b", undefined);
    t.emitExit({ code: 1, signal: null });
    await expect(a).rejects.toThrow(/transport closed/);
    await expect(b).rejects.toThrow(/transport closed/);
  });

  it("uses monotonically increasing ids", () => {
    const t = new FakeTransport();
    const c = new JsonRpcClient(t);
    void c.request("a", undefined).catch(() => undefined);
    void c.request("b", undefined).catch(() => undefined);
    const ids = t.written.map((w) => JSON.parse(w).id);
    expect(ids[1]).toBeGreaterThan(ids[0]);
  });
});

describe("JsonRpcClient notifications", () => {
  it("notify() writes a no-id envelope", () => {
    const t = new FakeTransport();
    const c = new JsonRpcClient(t);
    c.notify("hello", { from: "host" });
    const m = JSON.parse(t.written[0] ?? "{}");
    expect(m.method).toBe("hello");
    expect("id" in m).toBe(false);
  });

  it("on(method) fires for inbound notifications, with disposable removal", () => {
    const t = new FakeTransport();
    const c = new JsonRpcClient(t);
    const handler = vi.fn();
    const sub = c.on("body/update", handler);
    t.emit(
      `${JSON.stringify({ jsonrpc: "2.0", method: "body/update", params: { lines: ["x"] } })}\n`,
    );
    expect(handler).toHaveBeenCalledWith({ lines: ["x"] });
    sub.dispose();
    t.emit(
      `${JSON.stringify({ jsonrpc: "2.0", method: "body/update", params: { lines: ["y"] } })}\n`,
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores inbound requests it has no handler for, with method-not-found reply", () => {
    const t = new FakeTransport();
    void new JsonRpcClient(t);
    t.emit(`${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "doStuff" })}\n`);
    const reply = JSON.parse(t.written[0] ?? "{}");
    expect(reply.id).toBe(99);
    expect(reply.error.code).toBe(-32601);
  });
});

describe("JsonRpcClient lifecycle", () => {
  it("dispose() closes the transport and rejects pending requests", async () => {
    const t = new FakeTransport();
    const c = new JsonRpcClient(t);
    const p = c.request("never", undefined);
    c.dispose();
    expect(t.closed).toBe(true);
    await expect(p).rejects.toThrow(/transport closed/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```
pnpm --filter @aether/limbo-host exec vitest run src/adapters/rpc/client.test.ts
```

- [ ] **Step 3: Implement `client.ts`**

```typescript
// packages/host/src/adapters/rpc/client.ts
import type { IDisposable } from "../../pty/types.js";
import {
  type JsonRpcMessage,
  NdjsonDecoder,
  encodeError,
  encodeNotification,
  encodeRequest,
} from "./codec.js";
import type { ITransport } from "./transport.js";

const METHOD_NOT_FOUND = -32601;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

export type NotificationHandler = (params: unknown) => void;

export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly handlers = new Map<string, Set<NotificationHandler>>();
  private readonly decoder = new NdjsonDecoder();
  private readonly subs: IDisposable[];
  private closed = false;

  constructor(private readonly transport: ITransport) {
    this.subs = [
      transport.onData((chunk) => this.onChunk(chunk)),
      transport.onExit(() => this.shutdown(new RpcError(0, "transport closed"))),
    ];
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcError(0, "transport closed"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.transport.write(encodeRequest({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.transport.write(encodeNotification({ method, params }));
  }

  on(method: string, handler: NotificationHandler): IDisposable {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return {
      dispose: () => {
        set?.delete(handler);
      },
    };
  }

  dispose(): void {
    this.shutdown(new RpcError(0, "transport closed"));
    this.transport.close();
  }

  private onChunk(chunk: string): void {
    let messages: JsonRpcMessage[];
    try {
      messages = this.decoder.feed(chunk);
    } catch {
      return;
    }
    for (const m of messages) this.dispatch(m);
  }

  private dispatch(m: JsonRpcMessage): void {
    if ("id" in m && "result" in m) {
      const id = m.id;
      if (typeof id !== "number") return;
      this.pending.get(id)?.resolve(m.result);
      this.pending.delete(id);
      return;
    }
    if ("id" in m && "error" in m) {
      const id = m.id;
      if (typeof id !== "number") return;
      this.pending
        .get(id)
        ?.reject(new RpcError(m.error.code, m.error.message, m.error.data));
      this.pending.delete(id);
      return;
    }
    if ("method" in m && !("id" in m)) {
      const set = this.handlers.get(m.method);
      if (set) for (const h of set) h(m.params);
      return;
    }
    if ("method" in m && "id" in m) {
      this.transport.write(
        encodeError({ id: m.id, code: METHOD_NOT_FOUND, message: "method not found" }),
      );
    }
  }

  private shutdown(reason: unknown): void {
    if (this.closed) return;
    this.closed = true;
    for (const sub of this.subs) sub.dispose();
    for (const [, p] of this.pending) p.reject(reason);
    this.pending.clear();
    this.handlers.clear();
  }
}
```

- [ ] **Step 4: Run, expect PASS (8 tests)**

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/adapters/rpc/client.ts packages/host/src/adapters/rpc/client.test.ts
git commit -m "feat(host): JsonRpcClient with bidirectional request/notify"
```

---

## Task 5: Venv bootstrap (manifest, idempotency, lazy install)

**Goal:** Detect a usable venv, install missing extras on demand, and short-circuit when the manifest hash already matches. All filesystem and process operations are injected so unit tests stay hermetic.

**Files:**
- Create: `packages/host/src/adapters/sidecar/venv.ts`
- Create: `packages/host/src/adapters/sidecar/venv.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/host/src/adapters/sidecar/venv.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  type RunCommand,
  type Filesystem,
  VenvBootstrap,
  computeManifestHash,
} from "./venv.js";

function fakeFs(initial: Record<string, string> = {}): Filesystem {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    async exists(p) {
      return files.has(p);
    },
    async readFile(p) {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    async writeFile(p, c) {
      files.set(p, c);
    },
    async mkdir() {
      /* no-op for in-memory fs */
    },
  };
}

function fakeRun(): { calls: string[][]; run: RunCommand } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0 };
    },
  };
}

describe("computeManifestHash", () => {
  it("is stable across orderings of extras", () => {
    expect(computeManifestHash({ pythonVersion: "3.11.5", extras: ["a", "b"] })).toBe(
      computeManifestHash({ pythonVersion: "3.11.5", extras: ["b", "a"] }),
    );
  });

  it("changes when pythonVersion changes", () => {
    expect(computeManifestHash({ pythonVersion: "3.11.5", extras: [] })).not.toBe(
      computeManifestHash({ pythonVersion: "3.12.0", extras: [] }),
    );
  });
});

describe("VenvBootstrap.ensure", () => {
  it("creates the venv and installs the package on a cold start", async () => {
    const fs = fakeFs();
    const { run, calls } = fakeRun();
    const v = new VenvBootstrap({
      venvDir: "/v",
      pythonExe: "python3",
      pythonVersion: "3.11.5",
      packagePath: "/repo/packages/sidecars",
      fs,
      run,
      onProgress: vi.fn(),
    });
    await v.ensure(["echo"]);
    expect(calls[0]).toEqual(["python3", "-m", "venv", "/v"]);
    expect(calls[1]?.[0]).toBe("/v/bin/pip");
    expect(calls[1]).toContain("install");
  });

  it("emits progress events for each phase", async () => {
    const fs = fakeFs();
    const { run } = fakeRun();
    const onProgress = vi.fn();
    const v = new VenvBootstrap({
      venvDir: "/v",
      pythonExe: "python3",
      pythonVersion: "3.11.5",
      packagePath: "/repo/packages/sidecars",
      fs,
      run,
      onProgress,
    });
    await v.ensure([]);
    const phases = onProgress.mock.calls.map((c) => c[0].phase);
    expect(phases).toContain("creating-venv");
    expect(phases).toContain("installing-package");
    expect(phases).toContain("done");
  });

  it("is idempotent when manifest already matches", async () => {
    const expected = computeManifestHash({ pythonVersion: "3.11.5", extras: ["echo"] });
    const fs = fakeFs({
      "/v/bin/python": "",
      "/v/.limbo-manifest.json": JSON.stringify({
        pythonVersion: "3.11.5",
        extras: ["echo"],
        hash: expected,
      }),
    });
    const { run, calls } = fakeRun();
    const v = new VenvBootstrap({
      venvDir: "/v",
      pythonExe: "python3",
      pythonVersion: "3.11.5",
      packagePath: "/repo/packages/sidecars",
      fs,
      run,
      onProgress: vi.fn(),
    });
    await v.ensure(["echo"]);
    expect(calls).toEqual([]);
  });

  it("re-installs when an extra is requested that is not in the manifest", async () => {
    const expected = computeManifestHash({ pythonVersion: "3.11.5", extras: ["echo"] });
    const fs = fakeFs({
      "/v/bin/python": "",
      "/v/.limbo-manifest.json": JSON.stringify({
        pythonVersion: "3.11.5",
        extras: ["echo"],
        hash: expected,
      }),
    });
    const { run, calls } = fakeRun();
    const v = new VenvBootstrap({
      venvDir: "/v",
      pythonExe: "python3",
      pythonVersion: "3.11.5",
      packagePath: "/repo/packages/sidecars",
      fs,
      run,
      onProgress: vi.fn(),
    });
    await v.ensure(["echo", "instagram"]);
    const installArgs = calls.find((c) => c.includes("install"));
    expect(installArgs).toBeDefined();
    const target = installArgs?.find((a) => a.includes("[")) ?? "";
    expect(target).toContain("echo");
    expect(target).toContain("instagram");
  });

  it("propagates a non-zero pip exit as an error", async () => {
    const fs = fakeFs();
    const failingRun: RunCommand = async () => ({ code: 1, stderr: "pip exploded" });
    const v = new VenvBootstrap({
      venvDir: "/v",
      pythonExe: "python3",
      pythonVersion: "3.11.5",
      packagePath: "/repo/packages/sidecars",
      fs,
      run: failingRun,
      onProgress: vi.fn(),
    });
    await expect(v.ensure(["echo"])).rejects.toThrow(/pip/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `venv.ts`**

```typescript
// packages/host/src/adapters/sidecar/venv.ts
import { createHash } from "node:crypto";
import * as path from "node:path";

export interface Filesystem {
  exists(p: string): Promise<boolean>;
  readFile(p: string): Promise<string>;
  writeFile(p: string, content: string): Promise<void>;
  mkdir(p: string): Promise<void>;
}

export interface RunResult {
  readonly code: number;
  readonly stderr?: string;
}

export type RunCommand = (
  file: string,
  args: readonly string[],
  opts?: { cwd?: string },
) => Promise<RunResult>;

export type BootstrapPhase =
  | "creating-venv"
  | "installing-package"
  | "writing-manifest"
  | "done";

export interface BootstrapProgress {
  readonly phase: BootstrapPhase;
  readonly extras: readonly string[];
}

export interface VenvBootstrapOptions {
  readonly venvDir: string;
  readonly pythonExe: string;
  readonly pythonVersion: string;
  readonly packagePath: string;
  readonly fs: Filesystem;
  readonly run: RunCommand;
  readonly onProgress: (p: BootstrapProgress) => void;
}

interface Manifest {
  readonly pythonVersion: string;
  readonly extras: readonly string[];
  readonly hash: string;
}

export function computeManifestHash(args: {
  pythonVersion: string;
  extras: readonly string[];
}): string {
  const sorted = [...args.extras].sort();
  return createHash("sha256")
    .update(args.pythonVersion)
    .update("|")
    .update(sorted.join(","))
    .digest("hex");
}

const MANIFEST_NAME = ".limbo-manifest.json";

export class VenvBootstrap {
  constructor(private readonly opts: VenvBootstrapOptions) {}

  async ensure(extras: readonly string[]): Promise<void> {
    const dedup = Array.from(new Set(extras)).sort();
    const expected = computeManifestHash({
      pythonVersion: this.opts.pythonVersion,
      extras: dedup,
    });
    const venvPython = path.join(this.opts.venvDir, "bin", "python");
    const manifestPath = path.join(this.opts.venvDir, MANIFEST_NAME);

    const venvExists = await this.opts.fs.exists(venvPython);
    if (venvExists) {
      const cur = await this.readManifest(manifestPath);
      if (cur && cur.hash === expected) {
        this.opts.onProgress({ phase: "done", extras: dedup });
        return;
      }
    }

    if (!venvExists) {
      this.opts.onProgress({ phase: "creating-venv", extras: dedup });
      const r = await this.opts.run(this.opts.pythonExe, ["-m", "venv", this.opts.venvDir]);
      if (r.code !== 0) throw new Error(`venv create failed: ${r.stderr ?? ""}`);
    }

    this.opts.onProgress({ phase: "installing-package", extras: dedup });
    const pip = path.join(this.opts.venvDir, "bin", "pip");
    const target = dedup.length > 0
      ? `${this.opts.packagePath}[${dedup.join(",")}]`
      : this.opts.packagePath;
    const install = await this.opts.run(pip, ["install", "--quiet", "-e", target]);
    if (install.code !== 0) throw new Error(`pip install failed: ${install.stderr ?? ""}`);

    this.opts.onProgress({ phase: "writing-manifest", extras: dedup });
    const manifest: Manifest = {
      pythonVersion: this.opts.pythonVersion,
      extras: dedup,
      hash: expected,
    };
    await this.opts.fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    this.opts.onProgress({ phase: "done", extras: dedup });
  }

  private async readManifest(p: string): Promise<Manifest | undefined> {
    if (!(await this.opts.fs.exists(p))) return undefined;
    try {
      return JSON.parse(await this.opts.fs.readFile(p)) as Manifest;
    } catch {
      return undefined;
    }
  }
}
```

- [ ] **Step 4: Run, expect PASS (6 tests)**

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/adapters/sidecar/venv.ts packages/host/src/adapters/sidecar/venv.test.ts
git commit -m "feat(host): venv bootstrap with idempotent manifest hashing"
```

---

## Task 6: ChildProcessTransport (real `python -m limbo_sidecars` spawn)

**Goal:** A production `ITransport` that spawns the venv's Python with `-m limbo_sidecars <name>`, wires stdin/stdout to the JsonRpcClient, and surfaces exit. The class accepts an injectable `spawn` factory so unit tests can stub it.

**Files:**
- Create: `packages/host/src/adapters/sidecar/child-transport.ts`
- Create: `packages/host/src/adapters/sidecar/child-transport.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/host/src/adapters/sidecar/child-transport.test.ts
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ChildProcessTransport, type SpawnLike } from "./child-transport.js";

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killSignal: string | undefined;
  kill(sig?: string): void {
    this.killSignal = sig;
  }
}

describe("ChildProcessTransport", () => {
  it("spawns python with the configured args, env, and cwd", () => {
    const spawn: SpawnLike = vi.fn(() => new FakeChild() as unknown as ReturnType<SpawnLike>);
    const t = new ChildProcessTransport({
      pythonExe: "/v/bin/python",
      args: ["-m", "limbo_sidecars", "echo"],
      env: { LIMBO_TEST: "1" },
      cwd: "/repo",
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith(
      "/v/bin/python",
      ["-m", "limbo_sidecars", "echo"],
      expect.objectContaining({ env: expect.objectContaining({ LIMBO_TEST: "1" }), cwd: "/repo" }),
    );
    t.close();
  });

  it("write() pipes the chunk to child stdin", () => {
    const child = new FakeChild();
    const spawn: SpawnLike = () => child as unknown as ReturnType<SpawnLike>;
    const t = new ChildProcessTransport({
      pythonExe: "/v/bin/python",
      args: [],
      env: {},
      cwd: "/",
      spawn,
    });
    t.write("hello\n");
    expect(child.stdin.write).toHaveBeenCalledWith("hello\n");
  });

  it("onData fires for each stdout 'data' event (buffer is decoded as utf-8)", () => {
    const child = new FakeChild();
    const spawn: SpawnLike = () => child as unknown as ReturnType<SpawnLike>;
    const t = new ChildProcessTransport({
      pythonExe: "/v/bin/python",
      args: [],
      env: {},
      cwd: "/",
      spawn,
    });
    const seen: string[] = [];
    t.onData((c) => seen.push(c));
    child.stdout.emit("data", Buffer.from("a"));
    child.stdout.emit("data", Buffer.from("b"));
    expect(seen).toEqual(["a", "b"]);
  });

  it("onExit fires once with the child's exit code+signal", () => {
    const child = new FakeChild();
    const spawn: SpawnLike = () => child as unknown as ReturnType<SpawnLike>;
    const t = new ChildProcessTransport({
      pythonExe: "/v/bin/python",
      args: [],
      env: {},
      cwd: "/",
      spawn,
    });
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    t.onExit((e) => exits.push(e));
    child.emit("exit", 0, null);
    expect(exits).toEqual([{ code: 0, signal: null }]);
  });

  it("close() sends SIGTERM to the child", () => {
    const child = new FakeChild();
    const spawn: SpawnLike = () => child as unknown as ReturnType<SpawnLike>;
    const t = new ChildProcessTransport({
      pythonExe: "/v/bin/python",
      args: [],
      env: {},
      cwd: "/",
      spawn,
    });
    t.close();
    expect(child.killSignal).toBe("SIGTERM");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `child-transport.ts`**

```typescript
// packages/host/src/adapters/sidecar/child-transport.ts
import type { ChildProcess } from "node:child_process";
import type { IDisposable } from "../../pty/types.js";
import type { ITransport, TransportExit } from "../rpc/transport.js";

export type SpawnLike = (
  file: string,
  args: readonly string[],
  opts: { env: NodeJS.ProcessEnv; cwd: string },
) => ChildProcess;

export interface ChildProcessTransportOptions {
  readonly pythonExe: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly spawn: SpawnLike;
}

export class ChildProcessTransport implements ITransport {
  private readonly child: ChildProcess;
  private readonly dataListeners: Array<(chunk: string) => void> = [];
  private readonly exitListeners: Array<(e: TransportExit) => void> = [];

  constructor(opts: ChildProcessTransportOptions) {
    this.child = opts.spawn(opts.pythonExe, opts.args, { env: opts.env, cwd: opts.cwd });
    this.child.stdout?.on("data", (buf: Buffer | string) => {
      const s = typeof buf === "string" ? buf : buf.toString("utf8");
      for (const l of this.dataListeners) l(s);
    });
    this.child.on("exit", (code, signal) => {
      const ex: TransportExit = { code, signal };
      for (const l of this.exitListeners) l(ex);
    });
  }

  write(chunk: string): void {
    this.child.stdin?.write(chunk);
  }

  onData(listener: (chunk: string) => void): IDisposable {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        const i = this.dataListeners.indexOf(listener);
        if (i >= 0) this.dataListeners.splice(i, 1);
      },
    };
  }

  onExit(listener: (e: TransportExit) => void): IDisposable {
    this.exitListeners.push(listener);
    return {
      dispose: () => {
        const i = this.exitListeners.indexOf(listener);
        if (i >= 0) this.exitListeners.splice(i, 1);
      },
    };
  }

  close(): void {
    this.child.kill("SIGTERM");
  }
}
```

- [ ] **Step 4: Run, expect PASS (5 tests)**

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/adapters/sidecar/child-transport.ts packages/host/src/adapters/sidecar/child-transport.test.ts
git commit -m "feat(host): ChildProcessTransport for sidecar stdio"
```

---

## Task 7: OverlayPane (paints into the body region)

**Goal:** A concrete `IPane` that owns a sub-rect of the overlay's body, paints `setLines(lines)` truncated/centered, and forwards resize events.

**Files:**
- Create: `packages/host/src/adapters/pane.ts`
- Create: `packages/host/src/adapters/pane.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/host/src/adapters/pane.test.ts
import { describe, expect, it, vi } from "vitest";
import { OverlayPane } from "./pane.js";

interface FakeStdout {
  columns: number;
  rows: number;
  buffer: string[];
  write(c: string): boolean;
}
function makeStdout(cols = 80, rows = 24): FakeStdout {
  const buffer: string[] = [];
  return {
    columns: cols,
    rows,
    buffer,
    write(c) {
      buffer.push(c);
      return true;
    },
  };
}

describe("OverlayPane", () => {
  it("reports cols and rows from the body rect", () => {
    const stdout = makeStdout(100, 30);
    const pane = new OverlayPane({ stdout, topRow: 3, bottomRow: 28 });
    expect(pane.cols).toBe(100);
    expect(pane.rows).toBe(26);
  });

  it("setLines paints each line at consecutive rows starting at topRow", () => {
    const stdout = makeStdout(20, 10);
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 9 });
    pane.setLines(["alpha", "beta"]);
    const out = stdout.buffer.join("");
    expect(out).toContain("\x1b[2;1H");
    expect(out).toContain("alpha");
    expect(out).toContain("\x1b[3;1H");
    expect(out).toContain("beta");
  });

  it("setLines clears rows beyond the supplied lines", () => {
    const stdout = makeStdout(10, 10);
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 5 });
    pane.setLines(["x"]);
    const out = stdout.buffer.join("");
    expect(out).toContain("\x1b[3;1H");
    expect(out).toContain(" ".repeat(10));
  });

  it("setLines truncates lines longer than cols", () => {
    const stdout = makeStdout(5, 10);
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 5 });
    pane.setLines(["abcdefgh"]);
    const out = stdout.buffer.join("");
    expect(out).toContain("abcde");
    expect(out).not.toContain("abcdefgh");
  });

  it("on('resize') fires when handleResize is called", () => {
    const stdout = makeStdout(10, 10);
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 5 });
    const cb = vi.fn();
    pane.on("resize", cb);
    pane.handleResize(20, 30, { topRow: 2, bottomRow: 25 });
    expect(cb).toHaveBeenCalledWith(20, 24);
  });

  it("on('resize') returns a disposable that detaches the listener", () => {
    const stdout = makeStdout(10, 10);
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 5 });
    const cb = vi.fn();
    const sub = pane.on("resize", cb);
    sub.dispose();
    pane.handleResize(20, 30, { topRow: 2, bottomRow: 25 });
    expect(cb).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `pane.ts`**

```typescript
// packages/host/src/adapters/pane.ts
import type { IDisposable } from "../pty/types.js";
import type { IPane } from "./types.js";

interface StdoutLike {
  readonly columns?: number;
  readonly rows?: number;
  write(chunk: string): boolean;
}

const SGR_RESET = "\x1b[0m";

export interface OverlayPaneOptions {
  readonly stdout: StdoutLike;
  readonly topRow: number;
  readonly bottomRow: number;
}

export class OverlayPane implements IPane {
  private topRow_: number;
  private bottomRow_: number;
  private readonly resizeListeners: Array<(c: number, r: number) => void> = [];

  constructor(private readonly opts: OverlayPaneOptions) {
    this.topRow_ = opts.topRow;
    this.bottomRow_ = opts.bottomRow;
  }

  get cols(): number {
    return this.opts.stdout.columns ?? 80;
  }

  get rows(): number {
    return Math.max(0, this.bottomRow_ - this.topRow_);
  }

  setLines(lines: readonly string[]): void {
    const { stdout } = this.opts;
    const w = this.cols;
    for (let i = 0; i < this.rows; i++) {
      const target = this.topRow_ + i;
      stdout.write(`\x1b[${target};1H`);
      const raw = lines[i] ?? "";
      const line = raw.length > w ? raw.slice(0, w) : raw.padEnd(w);
      stdout.write(line);
    }
    stdout.write(SGR_RESET);
  }

  on(event: "resize", listener: (cols: number, rows: number) => void): IDisposable {
    if (event !== "resize") throw new Error(`OverlayPane: unknown event ${event}`);
    this.resizeListeners.push(listener);
    return {
      dispose: () => {
        const i = this.resizeListeners.indexOf(listener);
        if (i >= 0) this.resizeListeners.splice(i, 1);
      },
    };
  }

  handleResize(_cols: number, _rows: number, rect: { topRow: number; bottomRow: number }): void {
    this.topRow_ = rect.topRow;
    this.bottomRow_ = rect.bottomRow;
    for (const l of this.resizeListeners) l(this.cols, this.rows);
  }
}
```

- [ ] **Step 4: Run, expect PASS (6 tests)**

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/adapters/pane.ts packages/host/src/adapters/pane.test.ts
git commit -m "feat(host): OverlayPane — paints adapter body region"
```

---

## Task 8: Built-in adapter registry

**Goal:** A central registry that maps adapter ids to descriptors and respects per-adapter feature flags. For §4.6 the only registered descriptor is `echo`. Real adapters slot in during §4.7-§4.9.

**Files:**
- Create: `packages/host/src/adapters/registry.ts`
- Create: `packages/host/src/adapters/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/host/src/adapters/registry.test.ts
import { describe, expect, it, vi } from "vitest";
import { BuiltinAdapterRegistry } from "./registry.js";
import type { AdapterDescriptor, IAdapter } from "./types.js";

function makeDescriptor(id: string, enabled = true): AdapterDescriptor {
  return {
    id,
    extras: [],
    enabled,
    create: vi.fn(
      () =>
        ({
          id,
          mount: async () => undefined,
          unmount: async () => undefined,
          handleKey: () => undefined,
        }) as IAdapter,
    ),
  };
}

describe("BuiltinAdapterRegistry", () => {
  it("get(id) returns an adapter for an enabled descriptor", () => {
    const r = new BuiltinAdapterRegistry([makeDescriptor("echo")]);
    const a = r.get("echo");
    expect(a?.id).toBe("echo");
  });

  it("get(id) returns undefined for a disabled descriptor", () => {
    const r = new BuiltinAdapterRegistry([makeDescriptor("echo", false)]);
    expect(r.get("echo")).toBeUndefined();
  });

  it("get(id) returns undefined for an unknown id", () => {
    const r = new BuiltinAdapterRegistry([makeDescriptor("echo")]);
    expect(r.get("nope")).toBeUndefined();
  });

  it("list() returns all descriptors regardless of enabled", () => {
    const r = new BuiltinAdapterRegistry([
      makeDescriptor("echo", true),
      makeDescriptor("instagram", false),
    ]);
    expect(r.list()).toHaveLength(2);
  });

  it("create() is invoked once per get() call (no caching)", () => {
    const desc = makeDescriptor("echo");
    const r = new BuiltinAdapterRegistry([desc]);
    r.get("echo");
    r.get("echo");
    expect(desc.create).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `registry.ts`**

```typescript
// packages/host/src/adapters/registry.ts
import type { AdapterDescriptor, IAdapter, IAdapterRegistry } from "./types.js";

export class BuiltinAdapterRegistry implements IAdapterRegistry {
  private readonly byId = new Map<string, AdapterDescriptor>();

  constructor(private readonly descriptors: readonly AdapterDescriptor[]) {
    for (const d of descriptors) this.byId.set(d.id, d);
  }

  get(id: string): IAdapter | undefined {
    const d = this.byId.get(id);
    if (!d || !d.enabled) return undefined;
    return d.create();
  }

  list(): readonly AdapterDescriptor[] {
    return this.descriptors;
  }
}
```

- [ ] **Step 4: Run, expect PASS (5 tests)**

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/adapters/registry.ts packages/host/src/adapters/registry.test.ts
git commit -m "feat(host): BuiltinAdapterRegistry with feature-flag filtering"
```

---

## Task 9: Echo Python sidecar (`limbo_sidecars.echo`)

**Goal:** A self-contained Python module that speaks the JSON-RPC 2.0 NDJSON protocol over stdio, handles `ping`, `echo`, and emits a single `body/update` notification on startup.

**Files:**
- Create: `packages/sidecars/src/limbo_sidecars/jsonrpc.py`
- Create: `packages/sidecars/src/limbo_sidecars/echo.py`
- Create: `packages/sidecars/src/limbo_sidecars/__main__.py`
- Modify: `packages/sidecars/pyproject.toml` (widen `requires-python`, add `[project.scripts]`)
- Modify: `packages/sidecars/src/limbo_sidecars/__init__.py` (no behavior change; just docstring update)

- [ ] **Step 1: Widen the python version constraint and register the entry point**

Edit `packages/sidecars/pyproject.toml`:

```toml
# replace the existing requires-python line with:
requires-python = ">=3.11,<3.15"

# add (after [project.optional-dependencies]):
[project.scripts]
limbo-sidecar = "limbo_sidecars.__main__:main"
```

- [ ] **Step 2: Implement `jsonrpc.py` (NDJSON-framed JSON-RPC 2.0 server loop, stdlib only)**

```python
# packages/sidecars/src/limbo_sidecars/jsonrpc.py
"""Minimal NDJSON-framed JSON-RPC 2.0 server. Stdlib only.

Each line on stdin is exactly one JSON-RPC envelope. Each response/notification
written to stdout ends with a single '\n'. Anything written to stderr is
considered diagnostic noise (for users to see if they tail it).
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional, Union

METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603

JsonValue = Any  # JSON values are too dynamic to type narrowly here


@dataclass
class Request:
    id: Union[int, str]
    method: str
    params: Optional[JsonValue]


@dataclass
class Notification:
    method: str
    params: Optional[JsonValue]


Handler = Callable[[Optional[JsonValue]], JsonValue]


def _write(obj: JsonValue) -> None:
    sys.stdout.write(json.dumps(obj))
    sys.stdout.write("\n")
    sys.stdout.flush()


def respond(req_id: Union[int, str], result: JsonValue) -> None:
    _write({"jsonrpc": "2.0", "id": req_id, "result": result})


def respond_error(
    req_id: Union[int, str, None], code: int, message: str, data: JsonValue = None
) -> None:
    err = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    _write({"jsonrpc": "2.0", "id": req_id, "error": err})


def notify(method: str, params: JsonValue = None) -> None:
    msg = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        msg["params"] = params
    _write(msg)


def serve(handlers: dict[str, Handler]) -> None:
    """Read stdin line-by-line, dispatch to handlers, write replies. Returns on EOF."""
    for raw in sys.stdin:
        line = raw.rstrip("\n")
        if not line.strip():
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as err:
            respond_error(None, INTERNAL_ERROR, f"invalid JSON: {err}")
            continue
        if msg.get("jsonrpc") != "2.0":
            respond_error(None, INTERNAL_ERROR, "missing jsonrpc:'2.0' tag")
            continue
        method = msg.get("method")
        if method is None:
            # response from host — sidecar doesn't issue requests, so ignore
            continue
        params = msg.get("params")
        if "id" in msg:
            req_id = msg["id"]
            handler = handlers.get(method)
            if handler is None:
                respond_error(req_id, METHOD_NOT_FOUND, f"method not found: {method}")
                continue
            try:
                result = handler(params)
            except Exception as err:  # noqa: BLE001 — protocol boundary
                respond_error(req_id, INTERNAL_ERROR, str(err))
                continue
            respond(req_id, result)
        else:
            handler = handlers.get(method)
            if handler is not None:
                try:
                    handler(params)
                except Exception:  # noqa: BLE001 — silent for notifications
                    pass
```

- [ ] **Step 3: Implement `echo.py`**

```python
# packages/sidecars/src/limbo_sidecars/echo.py
"""Echo sidecar — proves the JSON-RPC wire format end-to-end.

Methods:
  ping(params)             -> "pong"
  echo({text: str})        -> {echoed: str, count: int}

Notifications emitted at startup:
  body/update {lines: [...]}  — one-shot, paints the initial pane content.
"""
from __future__ import annotations

from typing import Any

from . import jsonrpc

_count = 0


def _ping(_params: Any) -> str:
    return "pong"


def _echo(params: Any) -> dict[str, Any]:
    global _count
    _count += 1
    text = ""
    if isinstance(params, dict):
        text = str(params.get("text", ""))
    return {"echoed": text, "count": _count}


def main() -> int:
    jsonrpc.notify(
        "body/update",
        {"lines": ["echo sidecar ready", "round-trips: 0", "press j to ping"]},
    )
    jsonrpc.serve({"ping": _ping, "echo": _echo})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Implement `__main__.py` (dispatcher)**

```python
# packages/sidecars/src/limbo_sidecars/__main__.py
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
    sys.stderr.write(f"unknown adapter: {name}\n")
    return 64


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Smoke-test the python sidecar by hand**

Run from the repo root:

```bash
python3 -c "import sys; sys.path.insert(0, 'packages/sidecars/src'); \
  import json; from limbo_sidecars import jsonrpc; \
  print('jsonrpc module loaded')"
```

Expected: `jsonrpc module loaded` and exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/sidecars/pyproject.toml packages/sidecars/src/limbo_sidecars/
git commit -m "feat(sidecars): echo adapter + JSON-RPC server library"
```

---

## Task 10: Echo TS adapter

**Goal:** A `EchoAdapter` (TS-side) that uses the JsonRpcClient to talk to the Python echo sidecar and renders into the OverlayPane. This is the demo that proves the wire format works.

**Files:**
- Create: `packages/host/src/adapters/echo-adapter.ts`
- Create: `packages/host/src/adapters/echo-adapter.test.ts`

- [ ] **Step 1: Write the failing tests (against the in-memory FakeTransport)**

```typescript
// packages/host/src/adapters/echo-adapter.test.ts
import { describe, expect, it, vi } from "vitest";
import { OverlayPane } from "./pane.js";
import { EchoAdapter } from "./echo-adapter.js";
import { JsonRpcClient } from "./rpc/client.js";
import type { ITransport, TransportExit } from "./rpc/transport.js";
import type { IDisposable } from "../pty/types.js";

class PairedTransport implements ITransport {
  written: string[] = [];
  private dataListeners: Array<(c: string) => void> = [];
  private exitListeners: Array<(e: TransportExit) => void> = [];
  closed = false;
  write(c: string): void {
    this.written.push(c);
  }
  onData(l: (c: string) => void): IDisposable {
    this.dataListeners.push(l);
    return { dispose: () => undefined };
  }
  onExit(l: (e: TransportExit) => void): IDisposable {
    this.exitListeners.push(l);
    return { dispose: () => undefined };
  }
  close(): void {
    this.closed = true;
  }
  inject(c: string): void {
    for (const l of this.dataListeners) l(c);
  }
  exit(e: TransportExit): void {
    for (const l of this.exitListeners) l(e);
  }
}

function makeStdout(cols = 40, rows = 10) {
  const buf: string[] = [];
  return {
    columns: cols,
    rows,
    buffer: buf,
    write(c: string): boolean {
      buf.push(c);
      return true;
    },
  };
}

describe("EchoAdapter", () => {
  it("paints the body/update notification it receives on mount", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 9 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const a = new EchoAdapter({ client });
    const mounted = a.mount(pane);
    t.inject(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "body/update",
        params: { lines: ["one", "two"] },
      })}\n`,
    );
    await mounted;
    expect(stdout.buffer.join("")).toContain("one");
    expect(stdout.buffer.join("")).toContain("two");
  });

  it("handleKey({kind:'scroll-down'}) issues a `ping` request and increments the counter on success", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 9 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const a = new EchoAdapter({ client });
    await a.mount(pane);
    a.handleKey({ kind: "scroll-down" });
    const wrote = JSON.parse(t.written[0] ?? "{}");
    expect(wrote.method).toBe("ping");
    t.inject(`${JSON.stringify({ jsonrpc: "2.0", id: wrote.id, result: "pong" })}\n`);
    // allow microtask to drain
    await Promise.resolve();
    await Promise.resolve();
    expect(stdout.buffer.join("")).toMatch(/round-trips:\s*1/);
  });

  it("unmount() disposes the JsonRpcClient (closes the transport)", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 9 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const a = new EchoAdapter({ client });
    await a.mount(pane);
    await a.unmount();
    expect(t.closed).toBe(true);
  });

  it("ignores non-scroll-down key actions", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 9 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const a = new EchoAdapter({ client });
    await a.mount(pane);
    a.handleKey({ kind: "scroll-up" });
    a.handleKey({ kind: "scroll-top" });
    a.handleKey({ kind: "scroll-bottom" });
    expect(t.written).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `echo-adapter.ts`**

```typescript
// packages/host/src/adapters/echo-adapter.ts
import type { KeyAction } from "../overlay/types.js";
import type { IDisposable } from "../pty/types.js";
import { JsonRpcClient } from "./rpc/client.js";
import type { IAdapter, IPane } from "./types.js";

export interface EchoAdapterOptions {
  readonly client: JsonRpcClient;
}

interface BodyUpdateParams {
  readonly lines: readonly string[];
}

export class EchoAdapter implements IAdapter {
  readonly id = "echo";
  private pane: IPane | undefined;
  private subs: IDisposable[] = [];
  private roundTrips = 0;
  private lines: readonly string[] = [];

  constructor(private readonly opts: EchoAdapterOptions) {}

  async mount(pane: IPane): Promise<void> {
    this.pane = pane;
    this.subs.push(
      this.opts.client.on("body/update", (params) => {
        const p = params as BodyUpdateParams | undefined;
        if (p && Array.isArray(p.lines)) {
          this.lines = p.lines;
          this.repaint();
        }
      }),
    );
    this.subs.push(
      pane.on("resize", () => this.repaint()),
    );
  }

  async unmount(): Promise<void> {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.pane = undefined;
    this.opts.client.dispose();
  }

  handleKey(action: KeyAction): void {
    if (action.kind !== "scroll-down") return;
    void this.opts.client
      .request("ping", undefined)
      .then((result) => {
        if (result === "pong") {
          this.roundTrips++;
          this.repaint();
        }
      })
      .catch(() => {
        // sidecar errors are surfaced in the body region, not thrown
        this.lines = ["echo: sidecar error"];
        this.repaint();
      });
  }

  private repaint(): void {
    if (!this.pane) return;
    const out = this.lines.length > 0 ? [...this.lines] : ["echo sidecar ready"];
    if (out.length >= 2) out[1] = `round-trips: ${this.roundTrips}`;
    else out.push(`round-trips: ${this.roundTrips}`);
    this.pane.setLines(out);
  }
}
```

- [ ] **Step 4: Run, expect PASS (4 tests)**

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/adapters/echo-adapter.ts packages/host/src/adapters/echo-adapter.test.ts
git commit -m "feat(host): EchoAdapter — TS-side echo demo over JSON-RPC"
```

---

## Task 11: Wire registry + echo tab into LimboOverlay

**Goal:** Extend `TabDefinition` with an optional `adapterId`, teach `LimboOverlay` to mount/unmount the adapter when the active tab changes, route `scroll-*` actions to the active adapter, and force-unmount on `close()`.

**Files:**
- Modify: `packages/host/src/overlay/types.ts`
- Modify: `packages/host/src/overlay/overlay.ts`
- Modify: `packages/host/src/overlay/overlay.test.ts` (extend with adapter-mount cases)

- [ ] **Step 1: Extend `OverlayDeps` and `TabDefinition`**

Edit `packages/host/src/overlay/types.ts`:

```typescript
import type { IAdapterRegistry } from "../adapters/types.js";
import type { IClaudeDetector } from "../detector/types.js";
import type { HotkeyChord, StdoutView } from "../hotkey/types.js";

export type TabId = "reels" | "feed" | "dms" | "x" | "tiktok" | "__echo";

export interface TabDefinition {
  readonly id: TabId;
  readonly label: string;
  readonly placeholderRef: string;
  readonly adapterId?: string;
}

export const DEFAULT_TABS: readonly TabDefinition[] = [
  { id: "reels", label: "Reels", placeholderRef: "§4.7" },
  { id: "feed", label: "Feed", placeholderRef: "§4.7" },
  { id: "dms", label: "DMs", placeholderRef: "§4.7" },
  { id: "x", label: "X", placeholderRef: "§4.8" },
  { id: "tiktok", label: "TikTok", placeholderRef: "§4.9" },
];

export type KeyAction =
  | { kind: "close" }
  | { kind: "tab-prev" }
  | { kind: "tab-next" }
  | { kind: "tab-jump"; index: number }
  | { kind: "scroll-up" }
  | { kind: "scroll-down" }
  | { kind: "scroll-top" }
  | { kind: "scroll-bottom" };

export interface KeymapResult {
  readonly actions: readonly KeyAction[];
}

export interface OverlayDeps {
  readonly stdout: StdoutView;
  readonly detector: IClaudeDetector;
  readonly chord?: HotkeyChord;
  readonly tabs?: readonly TabDefinition[];
  readonly registry?: IAdapterRegistry;
}
```

- [ ] **Step 2: Add the new test cases to `overlay.test.ts`**

Append to `packages/host/src/overlay/overlay.test.ts`:

```typescript
import type { IAdapter, IAdapterRegistry, IPane } from "../adapters/types.js";

class RecordingAdapter implements IAdapter {
  readonly id = "rec";
  mountCalls = 0;
  unmountCalls = 0;
  keys: string[] = [];
  pane: IPane | undefined;
  async mount(pane: IPane): Promise<void> {
    this.mountCalls++;
    this.pane = pane;
  }
  async unmount(): Promise<void> {
    this.unmountCalls++;
  }
  handleKey(a: { kind: string }): void {
    this.keys.push(a.kind);
  }
}

function registryWith(adapter: IAdapter): IAdapterRegistry {
  return {
    get: (id: string) => (id === "rec" ? adapter : undefined),
    list: () => [],
  };
}

describe("LimboOverlay adapter integration", () => {
  it("mounts the active tab's adapter on open()", async () => {
    const detector = new FakeDetector();
    const stdout = makeStdout();
    const adapter = new RecordingAdapter();
    const overlay = new LimboOverlay({
      stdout,
      detector,
      registry: registryWith(adapter),
      tabs: [{ id: "__echo", label: "Echo", placeholderRef: "§4.6", adapterId: "rec" }],
    });
    overlay.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(adapter.mountCalls).toBe(1);
  });

  it("unmounts the previous adapter when the active tab changes", async () => {
    const detector = new FakeDetector();
    const stdout = makeStdout();
    const a1 = new RecordingAdapter();
    const a2 = new RecordingAdapter();
    let returnSecond = false;
    const registry: IAdapterRegistry = {
      get: () => (returnSecond ? a2 : a1),
      list: () => [],
    };
    const overlay = new LimboOverlay({
      stdout,
      detector,
      registry,
      tabs: [
        { id: "__echo", label: "Echo", placeholderRef: "§4.6", adapterId: "rec" },
        { id: "feed", label: "Feed", placeholderRef: "§4.6", adapterId: "rec" },
      ],
    });
    overlay.open();
    await Promise.resolve();
    returnSecond = true;
    overlay.handleInput("l");
    await Promise.resolve();
    await Promise.resolve();
    expect(a1.unmountCalls).toBe(1);
    expect(a2.mountCalls).toBe(1);
  });

  it("forwards scroll-* actions to the active adapter", async () => {
    const detector = new FakeDetector();
    const stdout = makeStdout();
    const adapter = new RecordingAdapter();
    const overlay = new LimboOverlay({
      stdout,
      detector,
      registry: registryWith(adapter),
      tabs: [{ id: "__echo", label: "Echo", placeholderRef: "§4.6", adapterId: "rec" }],
    });
    overlay.open();
    await Promise.resolve();
    overlay.handleInput("j");
    overlay.handleInput("k");
    expect(adapter.keys).toEqual(["scroll-down", "scroll-up"]);
  });

  it("force-unmounts the active adapter on close()", async () => {
    const detector = new FakeDetector();
    const stdout = makeStdout();
    const adapter = new RecordingAdapter();
    const overlay = new LimboOverlay({
      stdout,
      detector,
      registry: registryWith(adapter),
      tabs: [{ id: "__echo", label: "Echo", placeholderRef: "§4.6", adapterId: "rec" }],
    });
    overlay.open();
    await Promise.resolve();
    overlay.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(adapter.unmountCalls).toBe(1);
  });

  it("tabs without an adapterId fall back to the static placeholder body", () => {
    const detector = new FakeDetector();
    const stdout = makeStdout();
    const overlay = new LimboOverlay({ stdout, detector });
    overlay.open();
    expect(stdout.buffer.join("")).toContain("adapter not yet implemented");
  });
});
```

- [ ] **Step 3: Run the new tests, expect FAIL (5 new failures)**

```
pnpm --filter @aether/limbo-host exec vitest run src/overlay/overlay.test.ts
```

- [ ] **Step 4: Update `overlay.ts` to mount/unmount and route keys**

Replace the body of `packages/host/src/overlay/overlay.ts` with:

```typescript
import type { IAdapter, IAdapterRegistry } from "../adapters/types.js";
import { OverlayPane } from "../adapters/pane.js";
import { DEFAULT_CHORD, type HotkeyChord, type IOverlayController } from "../hotkey/types.js";
import type { IDisposable } from "../pty/types.js";
import { OverlayKeymap } from "./keymap.js";
import { renderStatusLine } from "./status-line.js";
import { renderTabBar } from "./tab-bar.js";
import { DEFAULT_TABS, type KeyAction, type OverlayDeps, type TabDefinition } from "./types.js";

const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_SCREEN = "\x1b[2J";
const HOME = "\x1b[H";
const SGR_RESET = "\x1b[0m";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function moveCursor(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

interface MountedAdapter {
  readonly adapter: IAdapter;
  readonly pane: OverlayPane;
}

export class LimboOverlay implements IOverlayController {
  private open_ = false;
  private activeIndex = 0;
  private readonly tabs: readonly TabDefinition[];
  private readonly chord: HotkeyChord;
  private readonly registry: IAdapterRegistry | undefined;
  private readonly keymap = new OverlayKeymap();
  private stateSub: IDisposable | undefined;
  private mounted: MountedAdapter | undefined;

  constructor(private readonly deps: OverlayDeps) {
    this.tabs = deps.tabs ?? DEFAULT_TABS;
    this.chord = deps.chord ?? DEFAULT_CHORD;
    this.registry = deps.registry;
  }

  isOpen(): boolean {
    return this.open_;
  }

  open(): void {
    if (this.open_) return;
    this.open_ = true;
    this.activeIndex = 0;
    this.keymap.reset();
    const { stdout } = this.deps;
    stdout.write(ALT_SCREEN_ENTER);
    stdout.write(HIDE_CURSOR);
    stdout.write(CLEAR_SCREEN);
    stdout.write(HOME);
    this.paint();
    this.stateSub = this.deps.detector.on("state", () => {
      if (this.open_) this.paintStatus();
    });
    void this.mountActive();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.stateSub?.dispose();
    this.stateSub = undefined;
    void this.unmountActive();
    const { stdout } = this.deps;
    stdout.write(SHOW_CURSOR);
    stdout.write(ALT_SCREEN_EXIT);
  }

  handleInput(chunk: string): void {
    if (!this.open_ || chunk.length === 0) return;
    const actions = this.keymap.feed(chunk);
    if (actions.length === 0) return;
    let needsFullRepaint = false;
    let shouldClose = false;
    let tabChanged = false;
    for (const action of actions) {
      if (this.applyAction(action)) {
        needsFullRepaint = true;
        if (
          action.kind === "tab-prev" ||
          action.kind === "tab-next" ||
          action.kind === "tab-jump"
        ) {
          tabChanged = true;
        }
      } else if (
        action.kind === "scroll-up" ||
        action.kind === "scroll-down" ||
        action.kind === "scroll-top" ||
        action.kind === "scroll-bottom"
      ) {
        this.mounted?.adapter.handleKey(action);
      }
      if (action.kind === "close") {
        shouldClose = true;
        break;
      }
    }
    if (shouldClose) {
      this.close();
      return;
    }
    if (tabChanged) {
      void this.unmountActive().then(() => this.mountActive());
    }
    if (needsFullRepaint) this.paint();
  }

  handleResize(_cols: number, _rows: number): void {
    if (!this.open_) return;
    this.paint();
  }

  private applyAction(action: KeyAction): boolean {
    switch (action.kind) {
      case "tab-prev":
        if (this.tabs.length === 0) return false;
        this.activeIndex = (this.activeIndex - 1 + this.tabs.length) % this.tabs.length;
        return true;
      case "tab-next":
        if (this.tabs.length === 0) return false;
        this.activeIndex = (this.activeIndex + 1) % this.tabs.length;
        return true;
      case "tab-jump":
        if (action.index < 0 || action.index >= this.tabs.length) return false;
        if (this.activeIndex === action.index) return false;
        this.activeIndex = action.index;
        return true;
      case "scroll-up":
      case "scroll-down":
      case "scroll-top":
      case "scroll-bottom":
      case "close":
        return false;
    }
  }

  private paint(): void {
    const { stdout } = this.deps;
    const cols = stdout.columns ?? DEFAULT_COLS;
    const rows = stdout.rows ?? DEFAULT_ROWS;
    stdout.write(HOME);
    stdout.write(CLEAR_SCREEN);
    stdout.write(moveCursor(1, 1));
    stdout.write(renderTabBar({ tabs: this.tabs, activeIndex: this.activeIndex, cols }));
    if (this.mounted === undefined) this.paintBody(cols, rows);
    this.paintStatus();
  }

  private paintBody(cols: number, rows: number): void {
    const { stdout } = this.deps;
    const tab = this.tabs[this.activeIndex];
    const bodyTopRow = 3;
    const bodyBottomRow = Math.max(bodyTopRow, rows - 1);
    for (let r = bodyTopRow; r < bodyBottomRow; r++) {
      stdout.write(moveCursor(r, 1));
      stdout.write(" ".repeat(cols));
    }
    if (tab !== undefined) {
      const lines = [`[ ${tab.label} ]`, "", `adapter not yet implemented (${tab.placeholderRef})`];
      const startRow = Math.max(
        bodyTopRow,
        Math.floor((bodyTopRow + bodyBottomRow - lines.length) / 2),
      );
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const col = Math.max(1, Math.floor((cols - line.length) / 2) + 1);
        stdout.write(moveCursor(startRow + i, col));
        stdout.write(line);
      }
    }
    stdout.write(SGR_RESET);
  }

  private paintStatus(): void {
    const { stdout } = this.deps;
    const cols = stdout.columns ?? DEFAULT_COLS;
    const rows = stdout.rows ?? DEFAULT_ROWS;
    const state = this.deps.detector.getState();
    stdout.write(moveCursor(rows, 1));
    stdout.write(renderStatusLine({ state, chord: this.chord, cols }));
  }

  private async mountActive(): Promise<void> {
    if (this.mounted !== undefined) return;
    if (!this.registry) return;
    const tab = this.tabs[this.activeIndex];
    if (!tab?.adapterId) return;
    const adapter = this.registry.get(tab.adapterId);
    if (!adapter) return;
    const cols = this.deps.stdout.columns ?? DEFAULT_COLS;
    const rows = this.deps.stdout.rows ?? DEFAULT_ROWS;
    const pane = new OverlayPane({
      stdout: this.deps.stdout,
      topRow: 3,
      bottomRow: Math.max(3, rows - 1),
    });
    this.mounted = { adapter, pane };
    try {
      await adapter.mount(pane);
    } catch {
      this.mounted = undefined;
    }
  }

  private async unmountActive(): Promise<void> {
    const m = this.mounted;
    if (!m) return;
    this.mounted = undefined;
    try {
      await m.adapter.unmount();
    } catch {
      // adapter teardown failures must not block the overlay lifecycle
    }
  }
}
```

- [ ] **Step 5: Run all overlay tests, expect PASS (existing + 5 new)**

```
pnpm --filter @aether/limbo-host exec vitest run src/overlay/overlay.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/host/src/overlay/types.ts packages/host/src/overlay/overlay.ts packages/host/src/overlay/overlay.test.ts
git commit -m "feat(host): mount/unmount adapter on tab change; route scroll-* keys"
```

---

## Task 12: Wire registry into the wrapper and gate the `__echo` tab on `LIMBO_DEBUG_ECHO`

**Goal:** Construct a default `BuiltinAdapterRegistry` that registers the `echo` descriptor, and conditionally append the `__echo` tab to the overlay's tab list when the env var is set.

**Files:**
- Modify: `packages/host/src/wrapper.ts`
- Modify: `packages/host/src/wrapper.test.ts` (add a test for env-gated tab injection)
- Modify: `packages/host/src/index.ts` (re-export the registry + types)

- [ ] **Step 1: Add wrapper test for env-gated `__echo` tab and registry plumbing**

Add to `packages/host/src/wrapper.test.ts`:

```typescript
it("appends the __echo tab when LIMBO_DEBUG_ECHO=1 is in the environment", async () => {
  const stdin = makeStdin();
  const stdout = makeStdout();
  const proc = new EventEmitter();
  let captured: MockPty | undefined;
  const factory = vi.fn((opts: PtySpawnOptions): IPty => {
    captured = new MockPty(opts);
    return captured;
  });
  let receivedOverlay: IOverlayController | undefined;
  const promise = runWrapper({
    claudeBin: "/fake/claude",
    argv: [],
    env: { LIMBO_DEBUG_ECHO: "1" },
    cwd: "/tmp",
    stdin,
    stdout: stdout as unknown as NodeJS.WriteStream,
    process: proc as unknown as NodeJS.Process,
    ptyFactory: factory,
    onOverlay: (o) => {
      receivedOverlay = o;
    },
  });
  if (!captured) throw new Error("factory not invoked synchronously");
  expect(receivedOverlay).toBeDefined();
  receivedOverlay?.open();
  expect(stdout.written.join("")).toContain("Echo");
  receivedOverlay?.close();
  captured.emitExit({ exitCode: 0 });
  await promise;
});

it("omits the __echo tab when LIMBO_DEBUG_ECHO is unset", async () => {
  const { stdout, pty, promise } = setup();
  // setup() passes `env: { PATH: "/usr/bin" }` — LIMBO_DEBUG_ECHO is absent
  const overlayOpen = stdout.written.join("");
  expect(overlayOpen).not.toContain(" Echo ");
  pty.emitExit({ exitCode: 0 });
  await promise;
});
```

- [ ] **Step 2: Run, expect FAIL on the new test**

```
pnpm --filter @aether/limbo-host exec vitest run src/wrapper.test.ts
```

- [ ] **Step 3: Update `wrapper.ts` to construct the registry and conditionally append the tab**

Replace the `runWrapper` body's overlay construction in `packages/host/src/wrapper.ts`. Add at the top of the file:

```typescript
import { ChildProcessTransport } from "./adapters/sidecar/child-transport.js";
import { spawn as nodeSpawn } from "node:child_process";
import { BuiltinAdapterRegistry } from "./adapters/registry.js";
import { EchoAdapter } from "./adapters/echo-adapter.js";
import { JsonRpcClient } from "./adapters/rpc/client.js";
import type { AdapterDescriptor, IAdapter, IAdapterRegistry } from "./adapters/types.js";
import { DEFAULT_TABS, type TabDefinition } from "./overlay/types.js";
```

Extend `RunWrapperOptions`:

```typescript
export interface RunWrapperOptions {
  // … existing fields …
  readonly adapterRegistry?: IAdapterRegistry;
  readonly tabs?: readonly TabDefinition[];
}
```

Add a helper just above `runWrapper`:

```typescript
function defaultRegistry(opts: { env: NodeJS.ProcessEnv; cwd: string }): IAdapterRegistry {
  const echoDescriptor: AdapterDescriptor = {
    id: "echo",
    extras: [],
    enabled: true,
    create: (): IAdapter => {
      const transport = new ChildProcessTransport({
        pythonExe: "python3",
        args: ["-m", "limbo_sidecars", "echo"],
        env: opts.env,
        cwd: opts.cwd,
        spawn: nodeSpawn,
      });
      return new EchoAdapter({ client: new JsonRpcClient(transport) });
    },
  };
  return new BuiltinAdapterRegistry([echoDescriptor]);
}

function defaultTabs(env: NodeJS.ProcessEnv): readonly TabDefinition[] {
  if (env.LIMBO_DEBUG_ECHO === "1") {
    return [
      ...DEFAULT_TABS,
      { id: "__echo", label: "Echo", placeholderRef: "§4.6 demo", adapterId: "echo" },
    ];
  }
  return DEFAULT_TABS;
}
```

Then use them in the `LimboOverlay` construction:

```typescript
const registry: IAdapterRegistry = opts.adapterRegistry ?? defaultRegistry({ env: opts.env, cwd: opts.cwd });
const tabs: readonly TabDefinition[] = opts.tabs ?? defaultTabs(opts.env);

const overlay: IOverlayController =
  opts.overlay ??
  new LimboOverlay({
    stdout: opts.stdout,
    detector,
    registry,
    tabs,
    ...(opts.chord !== undefined ? { chord: opts.chord } : {}),
  });
opts.onOverlay?.(overlay);
```

- [ ] **Step 4: Run all wrapper tests, expect PASS**

```
pnpm --filter @aether/limbo-host exec vitest run src/wrapper.test.ts
```

- [ ] **Step 5: Re-export adapter public surface in `index.ts`**

```typescript
export { ClaudeNotFoundError, resolveClaudeBin } from "./resolve-claude.js";
export { translateExit } from "./pty/exit-code.js";
export { TerminalGuard } from "./terminal/terminal-guard.js";
export { runWrapper } from "./wrapper.js";
export type { IPty, PtyExit, PtyFactory, PtySpawnOptions } from "./pty/types.js";
export { BuiltinAdapterRegistry } from "./adapters/registry.js";
export type {
  IAdapter,
  IAdapterRegistry,
  AdapterDescriptor,
  IPane,
  AdapterLifecycleEvent,
} from "./adapters/types.js";
export const VERSION = "0.0.0";
```

- [ ] **Step 6: Commit**

```bash
git add packages/host/src/wrapper.ts packages/host/src/wrapper.test.ts packages/host/src/index.ts
git commit -m "feat(host): wire echo registry and LIMBO_DEBUG_ECHO tab into wrapper"
```

---

## Task 13: Adapter contract test with the real Python sidecar

**Goal:** A single integration test that spawns `python3 -m limbo_sidecars echo` from `packages/sidecars/src` (no venv install needed — echo has no third-party deps), drives it through the JsonRpcClient, and asserts a real round-trip. Gated behind `LIMBO_RUN_PYTHON_TESTS=1` so the default `pnpm test` stays hermetic.

**Files:**
- Create: `packages/host/test/adapter-roundtrip.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// packages/host/test/adapter-roundtrip.test.ts
import { spawn } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ChildProcessTransport } from "../src/adapters/sidecar/child-transport.js";
import { JsonRpcClient } from "../src/adapters/rpc/client.js";

const enabled = process.env.LIMBO_RUN_PYTHON_TESTS === "1";
const desc = enabled ? describe : describe.skip;

const SIDECAR_SRC = path.resolve(__dirname, "..", "..", "sidecars", "src");

desc("real python sidecar contract", () => {
  it("echo: ping -> pong", async () => {
    const transport = new ChildProcessTransport({
      pythonExe: "python3",
      args: ["-m", "limbo_sidecars", "echo"],
      env: { ...process.env, PYTHONPATH: SIDECAR_SRC },
      cwd: process.cwd(),
      spawn,
    });
    const client = new JsonRpcClient(transport);
    try {
      const result = await client.request("ping", undefined);
      expect(result).toBe("pong");
    } finally {
      client.dispose();
    }
  }, 10_000);

  it("echo: emits a body/update notification on startup", async () => {
    const transport = new ChildProcessTransport({
      pythonExe: "python3",
      args: ["-m", "limbo_sidecars", "echo"],
      env: { ...process.env, PYTHONPATH: SIDECAR_SRC },
      cwd: process.cwd(),
      spawn,
    });
    const client = new JsonRpcClient(transport);
    const seen = await new Promise<unknown>((resolve) => {
      client.on("body/update", (params) => resolve(params));
    });
    expect(seen).toMatchObject({ lines: expect.any(Array) });
    client.dispose();
  }, 10_000);
});
```

- [ ] **Step 2: Run with the gate set, expect PASS**

```
LIMBO_RUN_PYTHON_TESTS=1 pnpm --filter @aether/limbo-host exec vitest run test/adapter-roundtrip.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 3: Run without the gate, expect SKIP**

```
pnpm --filter @aether/limbo-host exec vitest run test/adapter-roundtrip.test.ts
```

Expected: 2 tests skipped (no failure).

- [ ] **Step 4: Commit**

```bash
git add packages/host/test/adapter-roundtrip.test.ts
git commit -m "test(host): real-python adapter round-trip contract test (opt-in)"
```

---

## Task 14: Update `PLAN.md` — check off §4.6 and append deferrals to §5.1

**Goal:** Mark §4.6 bullets done with the same level of forensic detail used in §4.3-§4.5, and add §4.6's deferred work items to the §5.1 single-source-of-truth table.

**Files:**
- Modify: `PLAN.md`

- [ ] **Step 1: Update `### 4.6` section in PLAN.md**

Replace lines 100-105 of `PLAN.md` with:

```markdown
### 4.6 Adapter layer (Node ↔ Python sidecars) ✓ done
- [x] Define `Adapter` interface: `mount(pane)`, `unmount()`, `handleKey(action)` *(`packages/host/src/adapters/types.ts`. `IPane` exposes `cols`, `rows`, `setLines(readonly string[])`, and `on('resize')`. `AdapterDescriptor` is the registry entry — `{id, extras, enabled, create()}` — and `AdapterLifecycleEvent` enumerates the lifecycle states for the future error/observability path)*
- [x] JSON-RPC over stdio between Node host and Python sidecar processes *(`packages/host/src/adapters/rpc/codec.ts` does encode/decode + `NdjsonDecoder` line buffering; `client.ts` is the bidirectional client with promise-correlated requests, fire-and-forget notifications, and inbound notification dispatch via `on(method, handler)`. Wire format is JSON-RPC 2.0 framed as one envelope per `\n` line. Python side is `packages/sidecars/src/limbo_sidecars/jsonrpc.py` — stdlib only, ~70 lines)*
- [x] First-run bootstrap: create venv at `~/.local/share/aether-limbo/venv`, install pinned requirements *(`packages/host/src/adapters/sidecar/venv.ts` — lazy ensure: detects venv via `bin/python` presence, hashes `{pythonVersion, sorted(extras)}` into `.limbo-manifest.json`, skips when manifest matches, runs `python -m venv` + `pip install -e .[extras]` otherwise. All filesystem and process operations injected for hermetic unit tests; one opt-in real-python integration test in `test/adapter-roundtrip.test.ts` gated by `LIMBO_RUN_PYTHON_TESTS=1`)*
- [x] Per-adapter feature flag in config *(today: `AdapterDescriptor.enabled: boolean` filtered by `BuiltinAdapterRegistry.get`. Carry-over from §4.6 — `[adapters]` config wiring lands with §4.11; the seam is already there)*
- [x] **Demo adapter:** echo sidecar wired into a hidden `__echo` tab gated by `LIMBO_DEBUG_ECHO=1`. Proves the wire format end-to-end: mount paints the sidecar's `body/update` notification, `j` issues `ping` and increments a round-trip counter rendered in the body region, unmount kills the sidecar via `SIGTERM`. `EchoAdapter` in `src/adapters/echo-adapter.ts`; Python side in `packages/sidecars/src/limbo_sidecars/echo.py`.
- [x] **Lifecycle:** lazy spawn on tab activation; force-unmount on overlay close *(seam in `LimboOverlay.mountActive` / `unmountActive` — adapter teardown failures are swallowed so they cannot block close. `wrapper.ts` constructs the default registry with `ChildProcessTransport` + `python3 -m limbo_sidecars <name>`)*
```

- [ ] **Step 2: Append §4.6 rows to the §5.1 deferred-work table**

Add these rows to the §5.1 table (after the existing D9 row):

```markdown
| D10 | Tab order driven by `[adapters]` config (now applies to `enabled` too) | §4.6 | §4.11 (`[adapters]`) | Config layer existing | `BuiltinAdapterRegistry` already gates on `AdapterDescriptor.enabled`. The `[adapters]` config block needs to flip per-adapter enabled flags and (re-)order tabs. Mechanical wiring once §4.11 lands. |
| D11 | Pane API for rich rendering (sixel / kitty graphics / sub-pane carbonyl) | §4.6 / §4.5 (D2) | §4.7 (Reels), §4.9 (TikTok) | An adapter actually requesting rich rendering | `OverlayPane.setLines(string[])` is plain-text only today. Rich rendering needs either `pane.write(bytes)` (raw SGR/sixel passthrough with bounds enforcement) or a sub-pane host for `carbonyl`. The latter dovetails with D2. Defer until §4.7 demands it. |
| D12 | Sidecar process kept warm across overlay close/open | §4.6 | §4.11 (`[adapters]` flag) | Performance complaint that doesn't exist yet | Spawn is ~50-200ms; users probably won't notice once Python warm-starts. If they do, add a `[adapters].keep_warm = true` flag and switch `unmountActive` to detach (not kill) and re-attach on next mount. The kill-on-close branch already runs in wrapper teardown. |
| D13 | Real adapters use the bootstrap path (`echo` does not exercise pip install with extras) | §4.6 | §4.7 (instagram) — first adapter with extras | The first real adapter | `VenvBootstrap` is unit-tested for the `dedup → manifest → install` happy path including the rebuild-on-extras-change branch. Echo has `extras: []` so the install command runs but installs nothing extra. The first time a user opens Reels (instagram extra), the install is exercised for real. Manual verification step lands in §4.13. |
| D14 | Python contract test on CI | §4.6 | §4.12 (CI step) | CI configuration | `test/adapter-roundtrip.test.ts` is gated by `LIMBO_RUN_PYTHON_TESTS=1`; CI must set this and ensure `python3 ≥ 3.11` is on `PATH`. Add to the §4.1 CI workflow when §4.12 distribution work picks up the workflow file. |
```

- [ ] **Step 3: Commit**

```bash
git add PLAN.md
git commit -m "docs: mark §4.6 done; record §4.6 deferrals (D10-D14) in §5.1"
```

---

## Task 15: Final verification

**Goal:** Run the full host test suite, type-check, and lint to confirm §4.6 is green from a cold run.

- [ ] **Step 1: Run typecheck on the host package**

```bash
pnpm --filter @aether/limbo-host typecheck
```

Expected: no errors, exit 0.

- [ ] **Step 2: Run all host unit tests**

```bash
pnpm --filter @aether/limbo-host test
```

Expected: all green; new test counts roughly: codec (9), client (8), transport (1), venv (6), child-transport (5), pane (6), registry (5), echo-adapter (4), overlay (existing + 5 new), wrapper (existing + 2 new), types (6 type-level). Plus the round-trip contract test reports as **skipped** (because `LIMBO_RUN_PYTHON_TESTS` is not set in the default run).

- [ ] **Step 3: Run lint**

```bash
pnpm lint
```

Expected: no errors (biome ignores `**/*.py`, so the new Python files don't get checked here — Python lint runs in CI per the §4.1 workflow).

- [ ] **Step 4: Run the opt-in contract test once locally to prove the wire works**

```bash
LIMBO_RUN_PYTHON_TESTS=1 pnpm --filter @aether/limbo-host exec vitest run test/adapter-roundtrip.test.ts
```

Expected: 2 tests pass (`ping → pong`, startup `body/update` notification).

- [ ] **Step 5: Manual verification of the demo tab**

```bash
pnpm build
LIMBO_DEBUG_ECHO=1 pnpm limbo --version    # smoke
# In a real session:
LIMBO_DEBUG_ECHO=1 packages/host/dist/cli.js
# Send Claude a long prompt so state ≠ idle, then press Ctrl+L,
# navigate to the Echo tab with `l` until it's active, press `j` a few times,
# observe round-trip counter increment, press `q` to close, observe sidecar exits.
```

- [ ] **Step 6: Commit any leftover formatting changes**

```bash
git status
# If biome reformatted anything during step 3:
pnpm lint:fix
git add -A
git commit -m "chore: biome auto-format after §4.6 landing"
```

---

## Self-review checklist

Run this against the spec (`PLAN.md` §4.6 lines 100-105) before declaring the plan done:

**Spec coverage:**
- ✅ "Define `Adapter` interface" → Task 1 creates `IAdapter` with `mount(pane)`, `unmount()`, `handleKey(action)`.
- ✅ "JSON-RPC over stdio" → Tasks 2-4 (codec + client + transport) and Task 9 (Python server).
- ✅ "First-run bootstrap" → Task 5 (`VenvBootstrap`), Task 13 (real-python contract test).
- ✅ "Per-adapter feature flag in config" → Task 8 (`AdapterDescriptor.enabled` filtered by `BuiltinAdapterRegistry`); §4.11 carry-over recorded as D10.

**Backlog completion (per user instruction "Never leave any backlog tasks"):**
- The four §4.6 bullets are all checked off in Task 14.
- Items deferred from §4.6 are explicitly recorded in §5.1 as D10-D14, each with a precise unblocker, so nothing is left implicit.

**Placeholder scan:**
- Every code step shows the actual code (no `TODO`, no `// implement later`, no `add appropriate error handling`).
- Test code is fully written, not "write a test for this".
- File paths are exact, not "the appropriate file".

**Type consistency:**
- `IPane.setLines(readonly string[])` — Task 1 defines, Tasks 7, 10, 11 use the same signature.
- `KeyAction` — Task 1 reuses the existing union from `overlay/types.ts`; no rename.
- `IAdapterRegistry.get(id)` returns `IAdapter | undefined` — Tasks 1, 8, 11 agree.
- `AdapterDescriptor.{id, extras, enabled, create}` — Tasks 1, 8, 12 use the same shape.
- `JsonRpcClient.{request, notify, on, dispose}` — Tasks 4, 10, 13 agree.

**Deferral discipline:**
- D10 (config-driven order), D11 (rich-render pane API), D12 (warm-keep optimization), D13 (real bootstrap exercise), D14 (CI Python step) are all recorded with a blocker that is real and concrete.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-26-task-4-6-adapter-layer.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration with isolation between tasks.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch with checkpoints for review.

Which approach should I take?
