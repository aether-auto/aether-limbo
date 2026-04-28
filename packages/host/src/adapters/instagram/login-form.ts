export type LoginField = "username" | "password" | "twoFactor" | "submit";

export interface LoginSnapshot {
  readonly field: LoginField;
  readonly username: string;
  readonly password: string;
  readonly twoFactor: string;
  readonly message: string | undefined;
  readonly requires2fa: boolean;
  readonly rememberMe: boolean;
}

export type LoginAction =
  | { kind: "submit"; payload: { username: string; password: string } }
  | { kind: "submit2fa"; payload: { username: string; password: string; code: string } };

export interface LoginFormOptions {
  /**
   * Called on successful login when rememberMe is true.
   * Receives plain credentials — the adapter wraps them into the correct LimboSecrets namespace.
   */
  onCredentialsConfirmed?: (creds: { username: string; password: string }) => void;
}

export class LoginForm {
  private _field: LoginField = "username";
  private _username = "";
  private _password = "";
  private _twoFactor = "";
  private _message: string | undefined = undefined;
  private _requires2fa = false;
  private _rememberMe = false;

  private readonly _onCredentialsConfirmed:
    | ((creds: { username: string; password: string }) => void)
    | undefined;

  constructor(opts?: LoginFormOptions) {
    this._onCredentialsConfirmed = opts?.onCredentialsConfirmed;
  }

  private activeFields(): LoginField[] {
    if (this._requires2fa) {
      return ["username", "password", "twoFactor", "submit"];
    }
    return ["username", "password", "submit"];
  }

  private cycleForward(): void {
    const fields = this.activeFields();
    const idx = fields.indexOf(this._field);
    this._field = fields[(idx + 1) % fields.length] as LoginField;
  }

  private getFieldValue(field: LoginField): string {
    switch (field) {
      case "username":
        return this._username;
      case "password":
        return this._password;
      case "twoFactor":
        return this._twoFactor;
      case "submit":
        return "";
    }
  }

  private setFieldValue(field: LoginField, value: string): void {
    switch (field) {
      case "username":
        this._username = value;
        break;
      case "password":
        this._password = value;
        break;
      case "twoFactor":
        this._twoFactor = value;
        break;
      case "submit":
        break;
    }
  }

  private trySubmit(): LoginAction | undefined {
    if (this._username === "" || this._password === "") {
      this._message = "username and password are required";
      return undefined;
    }
    if (this._requires2fa && this._twoFactor === "") {
      this._message = "2FA code required";
      return undefined;
    }
    this._message = undefined;
    if (this._rememberMe) {
      this._onCredentialsConfirmed?.({ username: this._username, password: this._password });
    }
    if (this._requires2fa) {
      return {
        kind: "submit2fa",
        payload: {
          username: this._username,
          password: this._password,
          code: this._twoFactor,
        },
      };
    }
    return {
      kind: "submit",
      payload: { username: this._username, password: this._password },
    };
  }

  feed(chunk: string): LoginAction | undefined {
    let result: LoginAction | undefined;
    for (const ch of chunk) {
      const code = ch.codePointAt(0) ?? 0;

      if (ch === "\t") {
        this.cycleForward();
        continue;
      }

      if (ch === "\r" || ch === "\n") {
        if (this._field === "submit") {
          result = this.trySubmit();
        } else {
          this.cycleForward();
        }
        continue;
      }

      if (ch === "\x7f") {
        if (this._field !== "submit") {
          const val = this.getFieldValue(this._field);
          if (val.length > 0) {
            this.setFieldValue(this._field, val.slice(0, -1));
          }
        }
        continue;
      }

      // 'm' key toggles remember-me (mnemonic: m = memorise).
      // Only active when on submit field to avoid interfering with text entry.
      if (ch === "m" && this._field === "submit") {
        this._rememberMe = !this._rememberMe;
        continue;
      }

      // Printable: 0x20–0x7e
      if (code >= 0x20 && code <= 0x7e) {
        if (this._field !== "submit") {
          this.setFieldValue(this._field, this.getFieldValue(this._field) + ch);
        }
      }

      // Other control bytes: silently ignore
    }
    return result;
  }

  setRequires2fa(req: boolean): void {
    this._requires2fa = req;
    if (req) {
      this._field = "twoFactor";
      this._message = undefined;
    }
  }

  setMessage(msg: string | undefined): void {
    this._message = msg;
  }

  snapshot(): LoginSnapshot {
    return {
      field: this._field,
      username: this._username,
      password: this._password,
      twoFactor: this._twoFactor,
      message: this._message,
      requires2fa: this._requires2fa,
      rememberMe: this._rememberMe,
    };
  }

  renderLines(cols: number): string[] {
    const trunc = (s: string): string => s.slice(0, cols);

    const arrow = (active: boolean): string => (active ? "→" : " ");

    const lines: string[] = [];

    // Username line
    lines.push(trunc(`${arrow(this._field === "username")} Username: ${this._username}`));

    // Password line (masked)
    const masked = "*".repeat(this._password.length);
    lines.push(trunc(`${arrow(this._field === "password")} Password: ${masked}`));

    // 2FA line (only when requires2fa)
    if (this._requires2fa) {
      lines.push(trunc(`${arrow(this._field === "twoFactor")} 2FA code: ${this._twoFactor}`));
    }

    // Submit line
    lines.push(trunc(`${arrow(this._field === "submit")} [ Submit ]   (Tab/Enter to navigate)`));

    // Remember-me toggle (m key when on submit)
    const rmBox = this._rememberMe ? "[x]" : "[ ]";
    lines.push(trunc(`  ${rmBox} remember me  (m: toggle)`));

    // Message line
    if (this._message !== undefined) {
      lines.push(trunc(""));
      lines.push(trunc(this._message));
    }

    return lines;
  }
}
