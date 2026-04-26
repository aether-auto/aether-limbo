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
