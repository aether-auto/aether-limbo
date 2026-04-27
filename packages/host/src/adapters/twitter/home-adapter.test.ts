import { describe, expect, it, vi } from "vitest";
import type { IDisposable } from "../../pty/types.js";
import { OverlayPane } from "../pane.js";
import { JsonRpcClient } from "../rpc/client.js";
import type { ITransport, TransportExit } from "../rpc/transport.js";
import { TwitterHomeAdapter } from "./home-adapter.js";

// ---------------------------------------------------------------------------
// PairedTransport — same shape as the IG adapter tests use.
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

  request(index: number): { id: number; method: string; params: unknown } {
    const raw = this.written[index] ?? "{}";
    return JSON.parse(raw) as { id: number; method: string; params: unknown };
  }

  lastRequest(): { id: number; method: string; params: unknown } {
    return this.request(this.written.length - 1);
  }

  resolve(result: unknown): void {
    const req = this.lastRequest();
    this.inject(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result })}\n`);
  }

  resolveAt(index: number, result: unknown): void {
    const req = this.request(index);
    this.inject(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result })}\n`);
  }
}

function makeStdout(cols = 80, rows = 24) {
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

const TWEETS = [
  {
    id: "111",
    author: "alice",
    text: "first tweet",
    url: "https://x.com/alice/status/111",
  },
  {
    id: "222",
    author: "bob",
    text: "second tweet",
    url: "https://x.com/bob/status/222",
  },
];

// Drive the adapter to "timeline" mode with TWEETS loaded.
async function bootToTimeline(
  t: PairedTransport,
  adapter: TwitterHomeAdapter,
  pane: OverlayPane,
): Promise<void> {
  const mountP = adapter.mount(pane);
  // index 0: validate
  expect(t.request(0).method).toBe("validate");
  t.resolve({ status: "ready" });
  await Promise.resolve();
  await Promise.resolve();
  // index 1: timeline/list
  expect(t.lastRequest().method).toBe("timeline/list");
  t.resolve({ items: TWEETS });
  await mountP;
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TwitterHomeAdapter", () => {
  it("mount → validate ready → timeline/list rendered with first author", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TwitterHomeAdapter({
      client: new JsonRpcClient(t),
      runDetached: vi.fn().mockResolvedValue(undefined),
    });
    await bootToTimeline(t, adapter, pane);
    const output = stdout.buffer.join("");
    expect(output).toContain("@alice");
    expect(output).toContain("first tweet");
  });

  it("login_required → captureInput true; submit triggers `login` RPC", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TwitterHomeAdapter({
      client: new JsonRpcClient(t),
      runDetached: vi.fn().mockResolvedValue(undefined),
    });
    const mountP = adapter.mount(pane);
    t.resolve({ status: "login_required" });
    await mountP;
    await Promise.resolve();

    expect(adapter.captureInput?.("a")).toBe(true);
    adapter.captureInput?.("alice");
    adapter.captureInput?.("\t");
    adapter.captureInput?.("secret");
    adapter.captureInput?.("\t");
    adapter.captureInput?.("\r");

    await Promise.resolve();
    expect(t.lastRequest().method).toBe("login");
  });

  it("scroll-down then onEnter calls runDetached with second tweet's URL", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const runDetached = vi.fn().mockResolvedValue(undefined);
    const adapter = new TwitterHomeAdapter({
      client: new JsonRpcClient(t),
      runDetached,
    });
    await bootToTimeline(t, adapter, pane);

    adapter.handleKey({ kind: "scroll-down" });
    adapter.onEnter?.();

    expect(runDetached).toHaveBeenCalledOnce();
    expect(runDetached).toHaveBeenCalledWith("https://x.com/bob/status/222");
  });

  it("`l` in timeline mode fires timeline/like with selected tweet id", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TwitterHomeAdapter({
      client: new JsonRpcClient(t),
      runDetached: vi.fn().mockResolvedValue(undefined),
    });
    await bootToTimeline(t, adapter, pane);

    expect(adapter.captureInput?.("l")).toBe(true);
    await Promise.resolve();
    const req = t.lastRequest();
    expect(req.method).toBe("timeline/like");
    expect((req.params as { tweet_id: string }).tweet_id).toBe("111");

    t.resolve({ ok: true, message: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(stdout.buffer.join("")).toContain("liked @alice");
  });

  it("`r` enters reply mode; typed text + Enter fires timeline/reply", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TwitterHomeAdapter({
      client: new JsonRpcClient(t),
      runDetached: vi.fn().mockResolvedValue(undefined),
    });
    await bootToTimeline(t, adapter, pane);

    expect(adapter.captureInput?.("r")).toBe(true);
    expect(stdout.buffer.join("")).toContain("reply to @alice");

    for (const ch of "well said") adapter.captureInput?.(ch);
    expect(stdout.buffer.join("")).toContain("reply to @alice: well said_");

    adapter.captureInput?.("\r");
    await Promise.resolve();
    const req = t.lastRequest();
    expect(req.method).toBe("timeline/reply");
    expect(req.params as { tweet_id: string; text: string }).toEqual({
      tweet_id: "111",
      text: "well said",
    });

    t.resolve({ ok: true, message: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(stdout.buffer.join("")).toContain("reply sent");
  });

  it("`d` switches to dms_threads; available:false renders the unavailable message", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TwitterHomeAdapter({
      client: new JsonRpcClient(t),
      runDetached: vi.fn().mockResolvedValue(undefined),
    });
    await bootToTimeline(t, adapter, pane);

    expect(adapter.captureInput?.("d")).toBe(true);
    await Promise.resolve();
    expect(t.lastRequest().method).toBe("dms/threads");
    t.resolve({
      available: false,
      items: [],
      message: "DMs require X Premium",
    });
    await Promise.resolve();
    await Promise.resolve();

    const output = stdout.buffer.join("");
    expect(output).toContain("DMs require X Premium");
  });

  it("`d` then `t` toggles back to timeline (no extra RPCs)", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TwitterHomeAdapter({
      client: new JsonRpcClient(t),
      runDetached: vi.fn().mockResolvedValue(undefined),
    });
    await bootToTimeline(t, adapter, pane);

    adapter.captureInput?.("d");
    await Promise.resolve();
    t.resolve({ available: false, items: [] });
    await Promise.resolve();
    await Promise.resolve();

    const writesBeforeToggle = t.written.length;
    expect(adapter.captureInput?.("t")).toBe(true);
    expect(t.written.length).toBe(writesBeforeToggle);
    expect(stdout.buffer.join("")).toContain("[ X — Home ]");
  });

  it("dms_threads mode → onEnter loads dms/messages with selected thread id", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TwitterHomeAdapter({
      client: new JsonRpcClient(t),
      runDetached: vi.fn().mockResolvedValue(undefined),
    });
    await bootToTimeline(t, adapter, pane);

    adapter.captureInput?.("d");
    await Promise.resolve();
    t.resolve({
      available: true,
      items: [
        { thread_id: "t1", title: "alice", last_message: "hi" },
        { thread_id: "t2", title: "bob", last_message: "bye" },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    adapter.onEnter?.();
    await Promise.resolve();
    const req = t.lastRequest();
    expect(req.method).toBe("dms/messages");
    expect((req.params as { thread_id: string }).thread_id).toBe("t1");
  });

  it("captureInput in timeline mode falls through (returns false) for j/k", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TwitterHomeAdapter({
      client: new JsonRpcClient(t),
      runDetached: vi.fn().mockResolvedValue(undefined),
    });
    await bootToTimeline(t, adapter, pane);

    expect(adapter.captureInput?.("j")).toBe(false);
    expect(adapter.captureInput?.("k")).toBe(false);
    expect(adapter.captureInput?.("q")).toBe(false);
  });

  it("unmount() closes the JsonRpcClient transport", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TwitterHomeAdapter({
      client: new JsonRpcClient(t),
      runDetached: vi.fn().mockResolvedValue(undefined),
    });
    const mountP = adapter.mount(pane);
    t.resolve({ status: "login_required" });
    await mountP;
    await Promise.resolve();

    await adapter.unmount();
    expect(t.closed).toBe(true);
  });
});
