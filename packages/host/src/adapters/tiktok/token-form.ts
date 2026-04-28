export interface TokenFormSnapshot {
  readonly token: string;
  readonly message: string | undefined;
}

export type TokenFormAction =
  | { kind: "submit"; payload: { ms_token: string } }
  | { kind: "cancel" };

export class TokenForm {
  private _token = "";
  private _message: string | undefined = undefined;

  feed(chunk: string): TokenFormAction | undefined {
    for (const ch of chunk) {
      const code = ch.codePointAt(0) ?? 0;

      if (ch === "\r" || ch === "\n") {
        if (this._token.length > 0) {
          return { kind: "submit", payload: { ms_token: this._token } };
        }
        this._message = "ms_token required";
        return undefined;
      }

      if (ch === "\x1b") {
        this._token = "";
        return { kind: "cancel" };
      }

      if (ch === "\x7f") {
        if (this._token.length > 0) {
          this._token = this._token.slice(0, -1);
        }
        continue;
      }

      if (ch === "\t") {
        // no-op: single-field form, no field navigation
        continue;
      }

      // Printable: 0x20–0x7e
      if (code >= 0x20 && code <= 0x7e) {
        this._token += ch;
      }

      // Other control bytes: silently ignore
    }
    return undefined;
  }

  setMessage(msg: string | undefined): void {
    this._message = msg;
  }

  snapshot(): TokenFormSnapshot {
    return {
      token: this._token,
      message: this._message,
    };
  }

  renderLines(cols: number): string[] {
    const trunc = (s: string): string => s.slice(0, cols);

    const masked = this._maskToken(this._token);

    const lines: string[] = [
      trunc("[ TikTok session ]"),
      trunc(""),
      trunc("Paste ms_token cookie:"),
      trunc(`→ ms_token: ${masked}`),
      trunc(""),
      trunc("Enter: submit   Esc: cancel"),
    ];

    if (this._message !== undefined) {
      lines.push(trunc(""));
      lines.push(trunc(this._message));
    }

    return lines;
  }

  private _maskToken(token: string): string {
    if (token.length === 0) {
      return "";
    }
    if (token.length <= 4) {
      return token;
    }
    const visible = token.slice(-4);
    const stars = "*".repeat(token.length - 4);
    return stars + visible;
  }
}
