import { describe, expect, it, vi } from "vitest";
import { LoginForm } from "./login-form.js";

// ---------------------------------------------------------------------------
// rememberMe toggle
// ---------------------------------------------------------------------------

describe("LoginForm — rememberMe toggle", () => {
  it("defaults to rememberMe=false", () => {
    const form = new LoginForm();
    expect(form.snapshot().rememberMe).toBe(false);
  });

  it("'m' key on submit field toggles rememberMe on", () => {
    const form = new LoginForm();
    // Tab to submit (username → password → submit)
    form.feed("\t"); // → password
    form.feed("\t"); // → submit
    form.feed("m");
    expect(form.snapshot().rememberMe).toBe(true);
  });

  it("'m' key on submit field toggles back off", () => {
    const form = new LoginForm();
    form.feed("\t"); // → password
    form.feed("\t"); // → submit
    form.feed("m");
    form.feed("m");
    expect(form.snapshot().rememberMe).toBe(false);
  });

  it("'m' key on username field does NOT toggle rememberMe (appends to field instead)", () => {
    const form = new LoginForm();
    // starts on username
    form.feed("m");
    expect(form.snapshot().rememberMe).toBe(false);
    expect(form.snapshot().username).toBe("m");
  });

  it("'m' key on password field does NOT toggle rememberMe", () => {
    const form = new LoginForm();
    form.feed("\t"); // → password
    form.feed("m");
    expect(form.snapshot().rememberMe).toBe(false);
    expect(form.snapshot().password).toBe("m");
  });

  it("renderLines includes '[x] remember me' when rememberMe is true", () => {
    const form = new LoginForm();
    form.feed("\t"); // → password
    form.feed("\t"); // → submit
    form.feed("m");
    const lines = form.renderLines(80);
    expect(lines.join("\n")).toContain("[x]");
    expect(lines.join("\n")).toContain("remember me");
  });

  it("renderLines includes '[ ] remember me' when rememberMe is false", () => {
    const form = new LoginForm();
    const lines = form.renderLines(80);
    expect(lines.join("\n")).toContain("[ ]");
    expect(lines.join("\n")).toContain("remember me");
  });
});

// ---------------------------------------------------------------------------
// rememberMe=true → onCredentialsConfirmed called with plain creds (namespace-agnostic)
// ---------------------------------------------------------------------------

describe("LoginForm — rememberMe=true on submit fires onCredentialsConfirmed", () => {
  it("calls onCredentialsConfirmed with plain { username, password } — no namespace", () => {
    const cb = vi.fn();
    const form = new LoginForm({ onCredentialsConfirmed: cb });
    form.feed("alice"); // username
    form.feed("\t"); // → password
    form.feed("secret"); // password
    form.feed("\t"); // → submit
    form.feed("m"); // enable rememberMe
    form.feed("\r"); // submit

    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith({ username: "alice", password: "secret" });
  });

  it("calls onCredentialsConfirmed before returning action", () => {
    const order: string[] = [];
    const cb = vi.fn(() => {
      order.push("cb");
    });
    const form = new LoginForm({ onCredentialsConfirmed: cb });
    form.feed("u");
    form.feed("\t");
    form.feed("p");
    form.feed("\t");
    form.feed("m");
    const action = form.feed("\r");
    order.push("action");
    expect(action?.kind).toBe("submit");
    expect(order).toEqual(["cb", "action"]);
  });
});

// ---------------------------------------------------------------------------
// rememberMe=false → onCredentialsConfirmed NOT called
// ---------------------------------------------------------------------------

describe("LoginForm — rememberMe=false on submit does NOT fire onCredentialsConfirmed", () => {
  it("does not call onCredentialsConfirmed when rememberMe is off", () => {
    const cb = vi.fn();
    const form = new LoginForm({ onCredentialsConfirmed: cb });
    form.feed("alice");
    form.feed("\t");
    form.feed("secret");
    form.feed("\t");
    // rememberMe stays false
    form.feed("\r");

    expect(cb).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// rememberMe with 2FA
// ---------------------------------------------------------------------------

describe("LoginForm — rememberMe=true with 2FA fires onCredentialsConfirmed", () => {
  it("fires callback with plain { username, password } on submit2fa", () => {
    const cb = vi.fn();
    const form = new LoginForm({ onCredentialsConfirmed: cb });
    form.feed("alice");
    form.feed("\t");
    form.feed("secret");
    form.setRequires2fa(true); // focuses twoFactor
    form.feed("123456");
    form.feed("\t"); // → submit
    form.feed("m"); // enable rememberMe
    form.feed("\r"); // submit

    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith({ username: "alice", password: "secret" });
  });
});

// ---------------------------------------------------------------------------
// IG adapter namespace mapping — _makeLoginForm wraps creds into { instagram: ... }
// ---------------------------------------------------------------------------

describe("LoginForm — adapter wraps plain creds into instagram namespace", () => {
  it("IG adapter onCredentialsConfirmed receives { instagram: { username, password } }", () => {
    // Simulate what _makeLoginForm does in the IG adapters
    const adapterCb = vi.fn();
    const form = new LoginForm({
      onCredentialsConfirmed: (creds) => adapterCb({ instagram: creds }),
    });
    form.feed("bob");
    form.feed("\t");
    form.feed("pw2");
    form.feed("\t");
    form.feed("m");
    form.feed("\r");

    expect(adapterCb).toHaveBeenCalledOnce();
    expect(adapterCb).toHaveBeenCalledWith({ instagram: { username: "bob", password: "pw2" } });
  });

  it("Twitter adapter onCredentialsConfirmed receives { twitter: { username, password } }", () => {
    // Simulate what _makeLoginForm does in TwitterHomeAdapter
    const adapterCb = vi.fn();
    const form = new LoginForm({
      onCredentialsConfirmed: (creds) =>
        adapterCb({ twitter: { username: creds.username, password: creds.password } }),
    });
    form.feed("xuser");
    form.feed("\t");
    form.feed("xpass");
    form.feed("\t");
    form.feed("m");
    form.feed("\r");

    expect(adapterCb).toHaveBeenCalledOnce();
    expect(adapterCb).toHaveBeenCalledWith({
      twitter: { username: "xuser", password: "xpass" },
    });
  });
});
