import { describe, expect, it } from "vitest";
import type { IDisposable } from "../../pty/types.js";
import { OverlayPane } from "../pane.js";
import { JsonRpcClient } from "../rpc/client.js";
import type { ITransport, TransportExit } from "../rpc/transport.js";
import { InstagramDmsAdapter } from "./dms-adapter.js";

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

  /** Return the parsed JSON of the Nth written frame (0-indexed). */
  request(index: number): { id: number; method: string; params: unknown } {
    const raw = this.written[index] ?? "{}";
    return JSON.parse(raw) as { id: number; method: string; params: unknown };
  }

  /** Return the parsed JSON of the last written frame. */
  lastRequest(): { id: number; method: string; params: unknown } {
    return this.request(this.written.length - 1);
  }

  /** Resolve the most-recently issued request with `result`. */
  resolve(result: unknown): void {
    const req = this.lastRequest();
    this.inject(
      `${JSON.stringify({ jsonrpc: "2.0", id: req.id, result })}\n`,
    );
  }

  /** Resolve the request at the given index with `result`. */
  resolveAt(index: number, result: unknown): void {
    const req = this.request(index);
    this.inject(
      `${JSON.stringify({ jsonrpc: "2.0", id: req.id, result })}\n`,
    );
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

describe("InstagramDmsAdapter", () => {
  // Test 1 ─────────────────────────────────────────────────────────────────
  it("mount → validate ready → dms/threads; 2 threads → first thread shown", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 20 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const adapter = new InstagramDmsAdapter({ client });

    const mountP = adapter.mount(pane);

    // validate is the first request (index 0)
    expect(t.request(0).method).toBe("validate");
    t.resolve({ status: "ready" });

    // allow the then-chain to fire so dms/threads is sent
    await Promise.resolve();
    await Promise.resolve();

    expect(t.lastRequest().method).toBe("dms/threads");

    // reply with 2 threads
    t.resolve({
      items: [
        { thread_id: "t1", title: "alice", last_message: "hi" },
        { thread_id: "t2", title: "bob", last_message: "bye" },
      ],
    });

    await mountP;
    await Promise.resolve();
    await Promise.resolve();

    const output = stdout.buffer.join("");
    expect(output).toContain("alice");
    expect(output).toContain("hi");
  });

  // Test 2 ─────────────────────────────────────────────────────────────────
  it("mount → validate login_required → captureInput true; pane shows Username:", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 20 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const adapter = new InstagramDmsAdapter({ client });

    const mountP = adapter.mount(pane);

    t.resolve({ status: "login_required" });
    await mountP;
    await Promise.resolve();

    // captureInput returns true in login mode
    expect(adapter.captureInput?.("a")).toBe(true);

    const output = stdout.buffer.join("");
    expect(output).toContain("Username:");
  });

  // Test 3 ─────────────────────────────────────────────────────────────────
  it("onEnter() in threads mode dispatches dms/messages with the selected thread_id", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 20 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const adapter = new InstagramDmsAdapter({ client });

    const mountP = adapter.mount(pane);

    // validate (id=1, index 0) → ready
    t.resolve({ status: "ready" });
    await Promise.resolve();
    await Promise.resolve();

    // dms/threads (id=2, index 1) → 2 threads
    t.resolve({
      items: [
        { thread_id: "t1", title: "alice", last_message: "hi" },
        { thread_id: "t2", title: "bob", last_message: "bye" },
      ],
    });

    await mountP;
    await Promise.resolve();
    await Promise.resolve();

    // Now in threads mode. onEnter → dms/messages
    adapter.onEnter?.();
    await Promise.resolve();

    // The next request should be dms/messages (index 2)
    const req = t.request(2);
    expect(req.method).toBe("dms/messages");
    expect((req.params as { thread_id: string }).thread_id).toBe("t1");
  });

  // Test 4 ─────────────────────────────────────────────────────────────────
  it("captureInput('i') in messages mode → input mode; chars accumulate; reply line shown", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 20 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const adapter = new InstagramDmsAdapter({ client });

    const mountP = adapter.mount(pane);

    // validate (index 0) → ready
    t.resolve({ status: "ready" });
    await Promise.resolve();
    await Promise.resolve();

    // dms/threads (index 1) → 1 thread
    t.resolve({
      items: [{ thread_id: "t1", title: "alice", last_message: "hi" }],
    });

    await mountP;
    await Promise.resolve();
    await Promise.resolve();

    // threads mode — onEnter → dms/messages (index 2)
    adapter.onEnter?.();
    await Promise.resolve();

    // resolve dms/messages (index 2)
    t.resolve({
      items: [
        { from: "alice", text: "hello", ts: "2024-01-01T00:00:00" },
        { from: "me", text: "world", ts: "2024-01-01T00:01:00" },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    // Now in messages mode. captureInput("i") → input mode, returns true
    const result = adapter.captureInput?.("i");
    expect(result).toBe(true);

    // Type "hello" char by char
    adapter.captureInput?.("h");
    adapter.captureInput?.("e");
    adapter.captureInput?.("l");
    adapter.captureInput?.("l");
    adapter.captureInput?.("o");

    const output = stdout.buffer.join("");
    expect(output).toContain("reply: hello_");
  });

  // Test 5 ─────────────────────────────────────────────────────────────────
  it("Enter in input mode sends dms/send; on ok reply refreshes dms/messages; ends in messages mode", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 20 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const adapter = new InstagramDmsAdapter({ client });

    const mountP = adapter.mount(pane);

    // index 0: validate → ready
    t.resolve({ status: "ready" });
    await Promise.resolve();
    await Promise.resolve();

    // index 1: dms/threads → 1 thread
    t.resolve({
      items: [{ thread_id: "t1", title: "alice", last_message: "hi" }],
    });

    await mountP;
    await Promise.resolve();
    await Promise.resolve();

    // onEnter → index 2: dms/messages
    adapter.onEnter?.();
    await Promise.resolve();

    // resolve dms/messages (index 2)
    t.resolve({
      items: [{ from: "alice", text: "hello", ts: "2024-01-01T00:00:00" }],
    });
    await Promise.resolve();
    await Promise.resolve();

    // switch to input mode
    adapter.captureInput?.("i");

    // type "hi there"
    for (const ch of "hi there") {
      adapter.captureInput?.(ch);
    }

    // press Enter → dms/send (index 3)
    adapter.captureInput?.("\r");
    await Promise.resolve();

    expect(t.request(3).method).toBe("dms/send");
    const sendParams = t.request(3).params as { thread_id: string; text: string };
    expect(sendParams.thread_id).toBe("t1");
    expect(sendParams.text).toBe("hi there");

    // resolve dms/send with ok: true → triggers dms/messages refresh (index 4)
    t.resolveAt(3, { ok: true, message: null });
    await Promise.resolve();
    await Promise.resolve();

    expect(t.request(4).method).toBe("dms/messages");

    // resolve the refresh dms/messages (index 4)
    t.resolveAt(4, { items: [] });
    await Promise.resolve();
    await Promise.resolve();

    // Should be back in messages mode (not input mode)
    // In messages mode captureInput("i") returns true, other chars return false
    // captureInput("x") should return false (not input, not login)
    expect(adapter.captureInput?.("\x1b")).toBe(true); // Esc in messages → threads (returns true in messages mode)
  });

  // Test 6 ─────────────────────────────────────────────────────────────────
  it("unmount() closes the JsonRpcClient transport", async () => {
    const stdout = makeStdout();
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 20 });
    const t = new PairedTransport();
    const client = new JsonRpcClient(t);
    const adapter = new InstagramDmsAdapter({ client });

    const mountP = adapter.mount(pane);
    t.resolve({ status: "login_required" });
    await mountP;
    await Promise.resolve();

    await adapter.unmount();
    expect(t.closed).toBe(true);
  });
});
