import { describe, expect, it, vi } from "vitest";
import { TokenForm } from "./token-form.js";

// ---------------------------------------------------------------------------
// rememberMe toggle
// ---------------------------------------------------------------------------

describe("TokenForm — rememberMe toggle", () => {
  it("defaults to rememberMe=false", () => {
    const form = new TokenForm();
    expect(form.snapshot().rememberMe).toBe(false);
  });

  it("Ctrl+R (\\x12) toggles rememberMe on", () => {
    const form = new TokenForm();
    form.feed("\x12");
    expect(form.snapshot().rememberMe).toBe(true);
    // token must NOT have anything appended
    expect(form.snapshot().token).toBe("");
  });

  it("Ctrl+R (\\x12) toggles rememberMe back off", () => {
    const form = new TokenForm();
    form.feed("\x12");
    form.feed("\x12");
    expect(form.snapshot().rememberMe).toBe(false);
  });

  it("renderLines shows '[x] remember me' when true", () => {
    const form = new TokenForm();
    form.feed("\x12");
    const lines = form.renderLines(80);
    expect(lines.join("\n")).toContain("[x]");
    expect(lines.join("\n")).toContain("remember me");
  });

  it("renderLines shows '[ ] remember me' when false", () => {
    const form = new TokenForm();
    const lines = form.renderLines(80);
    expect(lines.join("\n")).toContain("[ ]");
    expect(lines.join("\n")).toContain("remember me");
  });

  it("Ctrl+R does not append to token — 'm' is now a normal printable char", () => {
    const form = new TokenForm();
    form.feed("ab");
    form.feed("\x12"); // toggle, not appended
    form.feed("mcd"); // 'm' is now a regular printable character
    expect(form.snapshot().token).toBe("abmcd");
    expect(form.snapshot().rememberMe).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rememberMe=true → onCredentialsConfirmed called on submit
// ---------------------------------------------------------------------------

describe("TokenForm — rememberMe=true fires onCredentialsConfirmed on submit", () => {
  it("calls callback with tiktok.msToken", () => {
    const cb = vi.fn();
    const form = new TokenForm({ onCredentialsConfirmed: cb });
    form.feed("\x12"); // enable rememberMe
    form.feed("eyJtoken123"); // token input
    form.feed("\r"); // submit

    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith({ tiktok: { msToken: "eyJtoken123" } });
  });

  it("callback is called before the action is returned", () => {
    const order: string[] = [];
    const cb = vi.fn(() => {
      order.push("cb");
    });
    const form = new TokenForm({ onCredentialsConfirmed: cb });
    form.feed("\x12");
    form.feed("tok");
    const action = form.feed("\r");
    order.push("action");
    expect(action?.kind).toBe("submit");
    expect(order).toEqual(["cb", "action"]);
  });
});

// ---------------------------------------------------------------------------
// rememberMe=false → onCredentialsConfirmed NOT called
// ---------------------------------------------------------------------------

describe("TokenForm — rememberMe=false does NOT fire onCredentialsConfirmed", () => {
  it("does not call callback when rememberMe is off", () => {
    const cb = vi.fn();
    const form = new TokenForm({ onCredentialsConfirmed: cb });
    form.feed("eyJtoken123");
    form.feed("\r");
    expect(cb).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cancel (Esc) does not fire callback even if rememberMe=true
// ---------------------------------------------------------------------------

describe("TokenForm — cancel never fires onCredentialsConfirmed", () => {
  it("Esc does not trigger callback", () => {
    const cb = vi.fn();
    const form = new TokenForm({ onCredentialsConfirmed: cb });
    form.feed("\x12");
    form.feed("tok");
    const action = form.feed("\x1b");
    expect(action?.kind).toBe("cancel");
    expect(cb).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// empty token submit does not fire callback
// ---------------------------------------------------------------------------

describe("TokenForm — empty submit does not fire callback", () => {
  it("callback not called when token is empty", () => {
    const cb = vi.fn();
    const form = new TokenForm({ onCredentialsConfirmed: cb });
    form.feed("\x12");
    // no token typed
    const action = form.feed("\r");
    expect(action).toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
  });
});
