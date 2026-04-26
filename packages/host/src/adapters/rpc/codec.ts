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
