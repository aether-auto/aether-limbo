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
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
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
      this.pending.get(id)?.reject(new RpcError(m.error.code, m.error.message, m.error.data));
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
