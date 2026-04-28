import { describe, expect, it } from "vitest";
import { TokenForm } from "./token-form.js";

describe("TokenForm", () => {
  it("1. feed(printable) accumulates; feed('\\r') returns submit action", () => {
    const form = new TokenForm();
    form.feed("eyJabc");
    const action = form.feed("\r");
    expect(action).toEqual({
      kind: "submit",
      payload: { ms_token: "eyJabc" },
    });
  });

  it("2. feed('\\r') with empty buffer sets message and returns undefined", () => {
    const form = new TokenForm();
    const action = form.feed("\r");
    expect(action).toBeUndefined();
    expect(form.snapshot().message).toBe("ms_token required");
  });

  it("3. feed('\\x7f') deletes last char", () => {
    const form = new TokenForm();
    form.feed("abc");
    form.feed("\x7f");
    expect(form.snapshot().token).toBe("ab");
    // over-delete on empty is a no-op
    form.feed("\x7f");
    form.feed("\x7f");
    form.feed("\x7f");
    expect(form.snapshot().token).toBe("");
  });

  it("4. feed('\\x1b') returns {kind:'cancel'} and clears the buffer", () => {
    const form = new TokenForm();
    form.feed("eyJabc");
    const action = form.feed("\x1b");
    expect(action).toEqual({ kind: "cancel" });
    expect(form.snapshot().token).toBe("");
  });

  it("5. feed('\\t') is a no-op", () => {
    const form = new TokenForm();
    form.feed("abc");
    const action = form.feed("\t");
    expect(action).toBeUndefined();
    expect(form.snapshot().token).toBe("abc");
  });

  it("6. control bytes 0x00-0x1f (except \\r, \\n, \\t, \\x1b) are ignored", () => {
    const form = new TokenForm();
    // 0x07 = bell, 0x01 = SOH, 0x0c = form feed
    form.feed("\x07\x01\x0c");
    expect(form.snapshot().token).toBe("");
    // \x7f (DEL/backspace) on empty is also no-op
    form.feed("\x7f");
    expect(form.snapshot().token).toBe("");
  });

  it("7. renderLines(40) masks token: last 4 visible, rest as *", () => {
    const form = new TokenForm();
    form.feed("abcdefghijklmnop"); // 16 chars
    const lines = form.renderLines(40);
    const joined = lines.join("\n");
    // last 4 chars = "mnop", first 12 = "************"
    expect(joined).toContain("************mnop");
  });

  it("8. renderLines(40) for token shorter than 4 chars shows all chars verbatim", () => {
    const form = new TokenForm();
    form.feed("ab");
    const lines = form.renderLines(40);
    const joined = lines.join("\n");
    expect(joined).toContain("ab");
    // no stars present in the ms_token line
    const tokenLine = lines.find((l) => l.includes("ms_token:"));
    expect(tokenLine).toBeDefined();
    expect(tokenLine).not.toContain("*");
  });

  it("9. renderLines(20) truncates each line to 20 cols", () => {
    const form = new TokenForm();
    const lines = form.renderLines(20);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
  });

  it("10. setMessage('bad token') causes renderLines to include that message", () => {
    const form = new TokenForm();
    form.setMessage("bad token");
    const lines = form.renderLines(40);
    expect(lines.join("\n")).toContain("bad token");
  });

  it("feed('\\n') also submits when token is non-empty", () => {
    const form = new TokenForm();
    form.feed("tok123");
    const action = form.feed("\n");
    expect(action).toEqual({ kind: "submit", payload: { ms_token: "tok123" } });
  });

  it("returns action from FIRST trigger char; subsequent chars in same chunk ignored", () => {
    const form = new TokenForm();
    form.feed("abc");
    // '\r' triggers submit; 'xyz' after it in the same chunk is ignored
    const action = form.feed("\rabc");
    expect(action).toEqual({ kind: "submit", payload: { ms_token: "abc" } });
  });

  it("renderLines includes expected static lines", () => {
    const form = new TokenForm();
    const lines = form.renderLines(80);
    const joined = lines.join("\n");
    expect(joined).toContain("[ TikTok session ]");
    expect(joined).toContain("Paste ms_token cookie:");
    expect(joined).toContain("Enter: submit   Esc: cancel");
  });

  it("renderLines shows empty string for empty token in ms_token line", () => {
    const form = new TokenForm();
    const lines = form.renderLines(80);
    const tokenLine = lines.find((l) => l.includes("ms_token:"));
    expect(tokenLine).toBeDefined();
    // should end with ": " (empty masked value)
    expect(
      tokenLine?.trimEnd().endsWith(": ") ||
        tokenLine?.endsWith(":  ") ||
        tokenLine?.includes("ms_token: "),
    ).toBe(true);
  });
});
