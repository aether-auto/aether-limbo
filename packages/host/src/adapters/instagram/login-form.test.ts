import { describe, expect, it } from "vitest";
import { LoginForm } from "./login-form.js";

describe("LoginForm", () => {
  it("1. starts on username field with empty values", () => {
    const form = new LoginForm();
    const snap = form.snapshot();
    expect(snap.field).toBe("username");
    expect(snap.username).toBe("");
    expect(snap.password).toBe("");
    expect(snap.twoFactor).toBe("");
    expect(snap.message).toBeUndefined();
    expect(snap.requires2fa).toBe(false);
  });

  it("2. printable chars append to active field; control bytes (e.g. \\x07 bell) are ignored", () => {
    const form = new LoginForm();
    form.feed("al");
    form.feed("\x07"); // bell — control byte, ignored
    form.feed("ice");
    expect(form.snapshot().username).toBe("alice");
    // control byte did not add anything
    expect(form.snapshot().username).toBe("alice");
  });

  it("3. Backspace deletes last char; over-delete is no-op", () => {
    const form = new LoginForm();
    form.feed("abc");
    form.feed("\x7f"); // backspace
    expect(form.snapshot().username).toBe("ab");
    // over-delete: two more backspaces when only 2 chars
    form.feed("\x7f");
    form.feed("\x7f");
    expect(form.snapshot().username).toBe("");
    // over-delete on empty: no-op
    form.feed("\x7f");
    expect(form.snapshot().username).toBe("");
  });

  it("4. Tab cycles fields: username → password → submit → wraps to username (no 2fa)", () => {
    const form = new LoginForm();
    expect(form.snapshot().field).toBe("username");
    form.feed("\t");
    expect(form.snapshot().field).toBe("password");
    form.feed("\t");
    expect(form.snapshot().field).toBe("submit");
    form.feed("\t");
    expect(form.snapshot().field).toBe("username");
  });

  it("5. Enter on submit with both fields non-empty emits submit action", () => {
    const form = new LoginForm();
    form.feed("alice");
    form.feed("\t"); // → password
    form.feed("secret");
    form.feed("\t"); // → submit
    const action = form.feed("\r"); // Enter on submit
    expect(action).toEqual({
      kind: "submit",
      payload: { username: "alice", password: "secret" },
    });
  });

  it("6. Enter on submit with empty fields sets message and emits no action", () => {
    const form = new LoginForm();
    // Tab to submit without filling fields
    form.feed("\t"); // → password
    form.feed("\t"); // → submit
    const action = form.feed("\r");
    expect(action).toBeUndefined();
    expect(form.snapshot().message).toBe("username and password are required");
  });

  it("7. setRequires2fa(true) inserts 2fa into the cycle and clears any prior message", () => {
    const form = new LoginForm();
    form.feed("\t"); // → password
    form.feed("\t"); // → submit
    form.feed("\r"); // trigger validation error message
    expect(form.snapshot().message).toBe("username and password are required");

    form.setRequires2fa(true);
    const snap = form.snapshot();
    expect(snap.requires2fa).toBe(true);
    expect(snap.field).toBe("twoFactor");
    expect(snap.message).toBeUndefined();

    // Cycle with 2fa: username → password → twoFactor → submit → username
    const form2 = new LoginForm();
    form2.setRequires2fa(true);
    // currently on twoFactor; tab to submit
    form2.feed("\t");
    expect(form2.snapshot().field).toBe("submit");
    form2.feed("\t");
    expect(form2.snapshot().field).toBe("username");
    form2.feed("\t");
    expect(form2.snapshot().field).toBe("password");
    form2.feed("\t");
    expect(form2.snapshot().field).toBe("twoFactor");
  });

  it("8. Enter on submit with 2fa required + code present emits submit2fa", () => {
    const form = new LoginForm();
    form.feed("alice");
    form.feed("\t"); // → password
    form.feed("secret");
    form.setRequires2fa(true); // focuses twoFactor
    form.feed("123456");
    form.feed("\t"); // → submit
    const action = form.feed("\r");
    expect(action).toEqual({
      kind: "submit2fa",
      payload: { username: "alice", password: "secret", code: "123456" },
    });
  });

  it("8b. Enter on submit with 2fa required but empty code sets message and emits no action", () => {
    const form = new LoginForm();
    form.feed("alice");
    form.feed("\t"); // → password
    form.feed("secret");
    form.setRequires2fa(true); // focuses twoFactor, code empty
    form.feed("\t"); // → submit
    const action = form.feed("\r");
    expect(action).toBeUndefined();
    expect(form.snapshot().message).toBe("2FA code required");
  });

  it("9. setMessage paints arbitrary text below the form", () => {
    const form = new LoginForm();
    form.setMessage("custom message here");
    expect(form.snapshot().message).toBe("custom message here");
    form.setMessage(undefined);
    expect(form.snapshot().message).toBeUndefined();
  });

  it("10. renderLines(cols) masks password, shows username, pads/truncates to cols", () => {
    const form = new LoginForm();
    form.feed("alice");
    form.feed("\t"); // → password
    form.feed("secret");

    const lines = form.renderLines(40);
    // password field should not be active (active is password now), check content
    // username should appear
    const joined = lines.join("\n");
    expect(joined).toContain("Username: alice");
    // password masked
    expect(joined).toContain("Password: ******");
    // no raw password
    expect(joined).not.toContain("secret");
    // all lines ≤ 40 chars
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    // active field (password) has arrow indicator
    const passLine = lines.find((l) => l.includes("Password:"));
    expect(passLine).toBeDefined();
    expect(passLine?.startsWith("→")).toBe(true);

    // username line should not have arrow (not active)
    const userLine = lines.find((l) => l.includes("Username:"));
    expect(userLine?.startsWith(" ")).toBe(true);

    // submit line present
    expect(joined).toContain("Submit");

    // message line when set
    form.setMessage("oops!");
    const lines2 = form.renderLines(40);
    expect(lines2.join("\n")).toContain("oops!");

    // 2fa line only when requires2fa
    expect(joined).not.toContain("2FA");
    form.setRequires2fa(true);
    const lines3 = form.renderLines(40);
    expect(lines3.join("\n")).toContain("2FA");
  });
});
