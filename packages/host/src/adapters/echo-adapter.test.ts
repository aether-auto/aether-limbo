import { describe, expect, it } from "vitest";
import type { IDisposable } from "../pty/types.js";
import { EchoAdapter } from "./echo-adapter.js";
import { OverlayPane } from "./pane.js";
import { JsonRpcClient } from "./rpc/client.js";
import type { ITransport, TransportExit } from "./rpc/transport.js";

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
