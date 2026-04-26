import { describe, expect, it } from "vitest";
import {
  type JsonRpcMessage,
  NdjsonDecoder,
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResponse,
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

  it("encodes an error response with optional `data` field", () => {
    const out = encodeError({
      id: 7,
      code: -32000,
      message: "boom",
      data: { stack: ["frame1", "frame2"] },
    });
    expect(JSON.parse(out)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32000, message: "boom", data: { stack: ["frame1", "frame2"] } },
    });
  });

  it("omits `params` when not provided to encodeRequest", () => {
    const parsed = JSON.parse(encodeRequest({ id: 1, method: "ping" }));
    expect("params" in parsed).toBe(false);
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

  it("returns [] when fed an empty string", () => {
    expect(new NdjsonDecoder().feed("")).toEqual([]);
  });

  it("throws when an envelope has the jsonrpc tag but no method/result/error", () => {
    const d = new NdjsonDecoder();
    expect(() => d.feed(`${JSON.stringify({ jsonrpc: "2.0" })}\n`)).toThrow(
      /method.*result.*error/,
    );
  });

  it("strips trailing \\r before parsing (CRLF tolerance)", () => {
    const d = new NdjsonDecoder();
    const line = JSON.stringify({ jsonrpc: "2.0", id: 1, result: 7 });
    const msgs = d.feed(`${line}\r\n`);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ jsonrpc: "2.0", id: 1, result: 7 });
  });
});
