import { describe, expect, it, vi } from "vitest";
import type { IDisposable } from "../../pty/types.js";
import { OverlayPane } from "../pane.js";
import { JsonRpcClient } from "../rpc/client.js";
import type { ITransport, TransportExit } from "../rpc/transport.js";
import { InstagramFeedAdapter } from "./feed-adapter.js";

// ---------------------------------------------------------------------------
// PairedTransport — mirrors the one in reels-adapter.test.ts (test-private copy)
// ---------------------------------------------------------------------------
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

  /** Return the parsed JSON of the last written frame. */
  lastRequest(): { id: number; method: string; params: unknown } {
    const raw = this.written[this.written.length - 1] ?? "{}";
    return JSON.parse(raw) as { id: number; method: string; params: unknown };
  }

  /** Resolve the most-recently issued request with `result`. */
  resolve(result: unknown): void {
    const req = this.lastRequest();
    this.inject(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result })}\n`);
  }
}

function makeStdout(cols = 80, rows = 20) {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InstagramFeedAdapter", () => {
  // Test 1 ─────────────────────────────────────────────────────────────────
  it("mount calls validate; login_required shows Username: in pane", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 20 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const runDetached = vi.fn().mockResolvedValue(undefined);
    const adapter = new InstagramFeedAdapter({ client, runDetached });

    const mountP = adapter.mount(pane);

    // validate is the first (and so far only) request
    const req = t.lastRequest();
    expect(req.method).toBe("validate");

    // reply: login_required
    t.resolve({ status: "login_required" });
    await mountP;
    await Promise.resolve(); // flush microtasks

    const output = stdout.buffer.join("");
    expect(output).toContain("Username:");
  });

  // Test 2 ─────────────────────────────────────────────────────────────────
  it("mount → validate ready → feed/list is next; 2 items → first author shown", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 20 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const runDetached = vi.fn().mockResolvedValue(undefined);
    const adapter = new InstagramFeedAdapter({ client, runDetached });

    const mountP = adapter.mount(pane);

    // validate → ready
    const validateReq = t.lastRequest();
    expect(validateReq.method).toBe("validate");
    t.resolve({ status: "ready" });

    // allow the then-chain to fire so feed/list is sent
    await Promise.resolve();
    await Promise.resolve();

    const listReq = t.lastRequest();
    expect(listReq.method).toBe("feed/list");

    // reply with 2 items
    t.resolve({
      items: [
        {
          pk: "1",
          code: "aaa",
          author: "alice",
          caption: "hello world",
          url: "https://www.instagram.com/p/aaa/",
        },
        {
          pk: "2",
          code: "bbb",
          author: "bob",
          caption: "second post",
          url: "https://www.instagram.com/p/bbb/",
        },
      ],
    });

    await mountP;
    await Promise.resolve();
    await Promise.resolve();

    const output = stdout.buffer.join("");
    expect(output).toContain("@alice");
  });

  // Test 3 ─────────────────────────────────────────────────────────────────
  it("captureInput true in login mode; false after login → feed/list completes", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 20 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const runDetached = vi.fn().mockResolvedValue(undefined);
    const adapter = new InstagramFeedAdapter({ client, runDetached });

    const mountP = adapter.mount(pane);

    // validate → login_required → switch to login mode
    t.resolve({ status: "login_required" });
    await mountP;
    await Promise.resolve();

    // In login mode captureInput returns true
    expect(adapter.captureInput?.("a")).toBe(true);

    // Type username, tab, password, tab, tab (to submit), enter
    adapter.captureInput?.("alice");
    adapter.captureInput?.("\t"); // → password field
    adapter.captureInput?.("secret");
    adapter.captureInput?.("\t"); // → submit field
    adapter.captureInput?.("\r"); // submit

    // The form should have triggered a login RPC request
    await Promise.resolve();
    const loginReq = t.lastRequest();
    expect(loginReq.method).toBe("login");

    // Reply ready → triggers feed/list
    t.resolve({ status: "ready" });
    await Promise.resolve();
    await Promise.resolve();

    const listReq = t.lastRequest();
    expect(listReq.method).toBe("feed/list");

    // Reply with empty list → list mode
    t.resolve({ items: [] });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Now in list mode — captureInput should return false
    expect(adapter.captureInput?.("x")).toBe(false);
  });

  // Test 4 ─────────────────────────────────────────────────────────────────
  it("scroll-down then onEnter calls runDetached with second item's URL", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 20 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const runDetached = vi.fn().mockResolvedValue(undefined);
    const adapter = new InstagramFeedAdapter({ client, runDetached });

    const mountP = adapter.mount(pane);

    // validate → ready
    t.resolve({ status: "ready" });
    await Promise.resolve();
    await Promise.resolve();

    // feed/list → 2 items
    t.resolve({
      items: [
        {
          pk: "1",
          code: "aaa",
          author: "alice",
          caption: "hello world",
          url: "https://www.instagram.com/p/aaa/",
        },
        {
          pk: "2",
          code: "bbb",
          author: "bob",
          caption: "second post",
          url: "https://www.instagram.com/p/bbb/",
        },
      ],
    });

    await mountP;
    await Promise.resolve();
    await Promise.resolve();

    // scroll down → selected = 1
    adapter.handleKey({ kind: "scroll-down" });

    // Enter → runDetached with second item's URL
    adapter.onEnter?.();

    expect(runDetached).toHaveBeenCalledOnce();
    expect(runDetached).toHaveBeenCalledWith("https://www.instagram.com/p/bbb/");
  });

  // Test 5 ─────────────────────────────────────────────────────────────────
  it("unmount() does NOT dispose the shared client (transport stays open)", async () => {
    // The JsonRpcClient is owned by SharedInstagramSidecar, not by this
    // adapter.  unmount() must not close the transport so the other two IG
    // adapters (reels, dms) can still use the same process.
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 20 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const runDetached = vi.fn().mockResolvedValue(undefined);
    const adapter = new InstagramFeedAdapter({ client, runDetached });

    const mountP = adapter.mount(pane);
    t.resolve({ status: "login_required" });
    await mountP;
    await Promise.resolve();

    await adapter.unmount();
    expect(t.closed).toBe(false);
  });

  // Test 6 ─────────────────────────────────────────────────────────────────
  it("thumbnails disabled (LIMBO_IG_THUMBNAILS=0): no feed/thumbnail request is sent", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 20 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const runDetached = vi.fn().mockResolvedValue(undefined);
    // Disable thumbnails via env
    const adapter = new InstagramFeedAdapter({
      client,
      runDetached,
      env: { LIMBO_IG_THUMBNAILS: "0" },
    });

    const mountP = adapter.mount(pane);
    t.resolve({ status: "ready" });
    await Promise.resolve();
    await Promise.resolve();

    // feed/list
    t.resolve({
      items: [
        {
          pk: "1",
          code: "aaa",
          author: "alice",
          caption: "hello",
          url: "https://www.instagram.com/p/aaa/",
        },
      ],
    });
    await mountP;
    await Promise.resolve();
    await Promise.resolve();

    // No feed/thumbnail request should have been issued
    const methods = t.written.map((w) => (JSON.parse(w) as { method: string }).method);
    expect(methods).not.toContain("feed/thumbnail");
  });

  // Test 7 ─────────────────────────────────────────────────────────────────
  it("thumbnails enabled: feed/thumbnail request is sent after feed/list", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 20 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const runDetached = vi.fn().mockResolvedValue(undefined);
    // Enable thumbnails with symbols format
    const adapter = new InstagramFeedAdapter({
      client,
      runDetached,
      env: { LIMBO_IG_THUMBNAILS: "1", LIMBO_GRAPHICS_PROTOCOL: "symbols" },
    });

    const mountP = adapter.mount(pane);
    t.resolve({ status: "ready" });
    await Promise.resolve();
    await Promise.resolve();

    // feed/list
    t.resolve({
      items: [
        {
          pk: "42",
          code: "aaa",
          author: "alice",
          caption: "hello",
          url: "https://www.instagram.com/p/aaa/",
        },
      ],
    });
    await mountP;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // feed/thumbnail should have been requested
    const methods = t.written.map((w) => (JSON.parse(w) as { method: string }).method);
    expect(methods).toContain("feed/thumbnail");
  });

  // Test 8 ─────────────────────────────────────────────────────────────────
  it("chafa-not-installed response (ok=false): silent fallback — text still shown", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 20 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const runDetached = vi.fn().mockResolvedValue(undefined);
    const adapter = new InstagramFeedAdapter({
      client,
      runDetached,
      env: { LIMBO_IG_THUMBNAILS: "1", LIMBO_GRAPHICS_PROTOCOL: "symbols" },
    });

    const mountP = adapter.mount(pane);
    t.resolve({ status: "ready" });
    await Promise.resolve();
    await Promise.resolve();

    t.resolve({
      items: [
        {
          pk: "99",
          code: "zzz",
          author: "bob",
          caption: "my post",
          url: "https://www.instagram.com/p/zzz/",
        },
      ],
    });
    await mountP;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Resolve the feed/thumbnail with a chafa-not-installed error
    t.resolve({ ok: false, message: "chafa not installed" });
    await Promise.resolve();
    await Promise.resolve();

    // Text should still be rendered (no crash, @bob is visible)
    const output = stdout.buffer.join("");
    expect(output).toContain("@bob");
  });
});
