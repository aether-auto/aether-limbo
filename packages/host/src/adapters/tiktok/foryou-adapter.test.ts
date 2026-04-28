import { describe, expect, it } from "vitest";
import type { IDisposable } from "../../pty/types.js";
import { OverlayPane } from "../pane.js";
import { JsonRpcClient } from "../rpc/client.js";
import type { ITransport, TransportExit } from "../rpc/transport.js";
import type { SubPaneController, SubPaneRect } from "./foryou-adapter.js";
import { TikTokForYouAdapter } from "./foryou-adapter.js";

// ---------------------------------------------------------------------------
// PairedTransport — mirrors twitter/home-adapter.test.ts exactly
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

// ---------------------------------------------------------------------------
// makeStdout helper
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Test videos
// ---------------------------------------------------------------------------
const VIDEOS = [
  {
    id: "v1",
    author: "alice",
    caption: "First",
    url: "https://www.tiktok.com/@alice/video/v1",
  },
  {
    id: "v2",
    author: "bob",
    caption: "Second",
    url: "https://www.tiktok.com/@bob/video/v2",
  },
  {
    id: "v3",
    author: "carol",
    caption: "Third",
    url: "https://www.tiktok.com/@carol/video/v3",
  },
];

// ---------------------------------------------------------------------------
// FakeSubPane helper
// ---------------------------------------------------------------------------
interface FakeSubPaneHandle {
  controller: SubPaneController;
  killCount: number;
  fireExit(): void;
}

function makeFakeSubPane(): FakeSubPaneHandle {
  let killCount = 0;
  const exitHandlers: Array<() => void> = [];

  const controller: SubPaneController = {
    kill() {
      killCount++;
    },
    onExit(handler: () => void): IDisposable {
      exitHandlers.push(handler);
      return {
        dispose: () => {
          const i = exitHandlers.indexOf(handler);
          if (i >= 0) exitHandlers.splice(i, 1);
        },
      };
    },
  };

  return {
    get controller() {
      return controller;
    },
    get killCount() {
      return killCount;
    },
    fireExit() {
      for (const h of exitHandlers) h();
    },
  };
}

// ---------------------------------------------------------------------------
// bootToFeed helper — drives mount → validate ready → feed/list with VIDEOS
// ---------------------------------------------------------------------------
async function bootToFeed(
  t: PairedTransport,
  adapter: TikTokForYouAdapter,
  pane: OverlayPane,
): Promise<void> {
  const mountP = adapter.mount(pane);
  // index 0: validate
  expect(t.request(0).method).toBe("validate");
  t.resolve({ status: "ready" });
  await Promise.resolve();
  await Promise.resolve();
  // next: feed/list
  expect(t.lastRequest().method).toBe("feed/list");
  t.resolve({ items: VIDEOS });
  await mountP;
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TikTokForYouAdapter", () => {
  // Test 1
  it("mount → validate ready → feed/list → renders @alice and First", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TikTokForYouAdapter({
      client: new JsonRpcClient(t),
      runSubPane: () => makeFakeSubPane().controller,
    });
    await bootToFeed(t, adapter, pane);
    const output = stdout.buffer.join("");
    expect(output).toContain("@alice");
    expect(output).toContain("First");
  });

  // Test 2
  it("validate login_required → token mode; captureInput consumed", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TikTokForYouAdapter({
      client: new JsonRpcClient(t),
      runSubPane: () => makeFakeSubPane().controller,
    });
    const mountP = adapter.mount(pane);
    t.resolve({ status: "login_required" });
    await mountP;
    await Promise.resolve();

    const output = stdout.buffer.join("");
    expect(output).toContain("[ TikTok session ]");
    expect(adapter.captureInput("anything")).toBe(true);
  });

  // Test 3
  it("token mode → typing token + Enter fires set_token; on ready fires feed/list", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TikTokForYouAdapter({
      client: new JsonRpcClient(t),
      runSubPane: () => makeFakeSubPane().controller,
    });
    const mountP = adapter.mount(pane);
    t.resolve({ status: "login_required" });
    await mountP;
    await Promise.resolve();

    // Type token and submit
    adapter.captureInput("eyJtoken123");
    adapter.captureInput("\r");
    await Promise.resolve();

    const req = t.lastRequest();
    expect(req.method).toBe("set_token");
    expect((req.params as { ms_token: string }).ms_token).toBe("eyJtoken123");

    // Reply with ready → next RPC is feed/list
    t.resolve({ status: "ready" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.lastRequest().method).toBe("feed/list");
  });

  // Test 4
  it("set_token returns failed → adapter stays in token mode with error message", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TikTokForYouAdapter({
      client: new JsonRpcClient(t),
      runSubPane: () => makeFakeSubPane().controller,
    });
    const mountP = adapter.mount(pane);
    t.resolve({ status: "login_required" });
    await mountP;
    await Promise.resolve();

    adapter.captureInput("badtoken");
    adapter.captureInput("\r");
    await Promise.resolve();

    t.resolve({ status: "failed", message: "bad token" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Should still be token mode — captureInput still returns true
    expect(adapter.captureInput("x")).toBe(true);
    const output = stdout.buffer.join("");
    expect(output).toContain("bad token");
  });

  // Test 5
  it("handleKey scroll-down advances selectedIndex; repaint shows ▸ next to @bob", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TikTokForYouAdapter({
      client: new JsonRpcClient(t),
      runSubPane: () => makeFakeSubPane().controller,
    });
    await bootToFeed(t, adapter, pane);

    adapter.handleKey({ kind: "scroll-down" });
    const output = stdout.buffer.join("");
    // After scroll-down, index=1 (bob) should be selected
    expect(output).toContain("▸");
    expect(output).toContain("@bob");
  });

  // Test 6
  it("captureInput('c') fires feed/comments with video_id v1; shows comment", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TikTokForYouAdapter({
      client: new JsonRpcClient(t),
      runSubPane: () => makeFakeSubPane().controller,
    });
    await bootToFeed(t, adapter, pane);

    expect(adapter.captureInput("c")).toBe(true);
    await Promise.resolve();

    const req = t.lastRequest();
    expect(req.method).toBe("feed/comments");
    expect((req.params as { video_id: string }).video_id).toBe("v1");

    t.resolve({ available: true, items: [{ from: "d", text: "hi" }] });
    await Promise.resolve();
    await Promise.resolve();

    const output = stdout.buffer.join("");
    expect(output).toContain("<d> hi");
  });

  // Test 7
  it("comments available:false renders the unavailable banner with message", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TikTokForYouAdapter({
      client: new JsonRpcClient(t),
      runSubPane: () => makeFakeSubPane().controller,
    });
    await bootToFeed(t, adapter, pane);

    adapter.captureInput("c");
    await Promise.resolve();
    t.resolve({
      available: false,
      items: [],
      message: "comments disabled by author",
    });
    await Promise.resolve();
    await Promise.resolve();

    const output = stdout.buffer.join("");
    expect(output).toContain("comments unavailable");
    expect(output).toContain("comments disabled by author");
  });

  // Test 8
  it("comments mode → captureInput Esc returns true and switches back to feed", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TikTokForYouAdapter({
      client: new JsonRpcClient(t),
      runSubPane: () => makeFakeSubPane().controller,
    });
    await bootToFeed(t, adapter, pane);

    adapter.captureInput("c");
    await Promise.resolve();
    t.resolve({ available: true, items: [] });
    await Promise.resolve();
    await Promise.resolve();

    const writesBeforeEsc = t.written.length;
    expect(adapter.captureInput("\x1b")).toBe(true);
    // No extra RPC
    expect(t.written.length).toBe(writesBeforeEsc);
    // Back in feed mode — captureInput("j") should fall through
    expect(adapter.captureInput("j")).toBe(false);
  });

  // Test 9
  it("onEnter calls runSubPane factory with correct url and rect; switches to playing", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();

    let capturedUrl: string | undefined;
    let capturedRect: SubPaneRect | undefined;
    const fake = makeFakeSubPane();

    const adapter = new TikTokForYouAdapter({
      client: new JsonRpcClient(t),
      runSubPane: (url, rect) => {
        capturedUrl = url;
        capturedRect = rect;
        return fake.controller;
      },
    });
    await bootToFeed(t, adapter, pane);

    adapter.onEnter();

    expect(capturedUrl).toBe("https://www.tiktok.com/@alice/video/v1");
    expect(capturedRect).toBeDefined();
    // Adapter switches to playing mode — captureInput("q") is consumed
    expect(adapter.captureInput("q")).toBe(true);
    const output = stdout.buffer.join("");
    expect(output).toContain("▶ Playing");
  });

  // Test 10
  it("playing mode → captureInput('q') kills subpane and returns to feed", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const fake = makeFakeSubPane();
    const adapter = new TikTokForYouAdapter({
      client: new JsonRpcClient(t),
      runSubPane: () => fake.controller,
    });
    await bootToFeed(t, adapter, pane);

    adapter.onEnter();
    expect(adapter.captureInput("q")).toBe(true);
    expect(fake.killCount).toBeGreaterThanOrEqual(1);
    // Back in feed mode
    expect(adapter.captureInput("j")).toBe(false);
  });

  // Test 11 & 12
  it("captureInput('j') and 'k' in feed mode fall through (return false)", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const adapter = new TikTokForYouAdapter({
      client: new JsonRpcClient(t),
      runSubPane: () => makeFakeSubPane().controller,
    });
    await bootToFeed(t, adapter, pane);

    expect(adapter.captureInput("j")).toBe(false);
    expect(adapter.captureInput("k")).toBe(false);
  });

  // Test 13
  it("unmount() disposes the JsonRpcClient transport and kills active subpane", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 22 });
    const t = new PairedTransport();
    const fake = makeFakeSubPane();
    const adapter = new TikTokForYouAdapter({
      client: new JsonRpcClient(t),
      runSubPane: () => fake.controller,
    });
    await bootToFeed(t, adapter, pane);

    // Enter playing mode
    adapter.onEnter();

    await adapter.unmount();
    expect(t.closed).toBe(true);
    expect(fake.killCount).toBeGreaterThanOrEqual(1);
  });
});
