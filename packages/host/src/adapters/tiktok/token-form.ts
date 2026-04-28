import type { LimboSecrets } from "../../config/secrets.js";

export interface TokenFormSnapshot {
  readonly token: string;
  readonly message: string | undefined;
  readonly rememberMe: boolean;
}

export type TokenFormAction =
  | { kind: "submit"; payload: { ms_token: string } }
  | { kind: "cancel" };

export interface TokenFormOptions {
  /** Called on successful submit when rememberMe is true. */
  onCredentialsConfirmed?: (secrets: Partial<LimboSecrets>) => void;
}

export class TokenForm {
  private _token = "";
  private _message: string | undefined = undefined;
  private _rememberMe = false;

  private readonly _onCredentialsConfirmed: ((secrets: Partial<LimboSecrets>) => void) | undefined;

  constructor(opts?: TokenFormOptions) {
    this._onCredentialsConfirmed = opts?.onCredentialsConfirmed;
  }

  feed(chunk: string): TokenFormAction | undefined {
    for (const ch of chunk) {
      const code = ch.codePointAt(0) ?? 0;

      if (ch === "\r" || ch === "\n") {
        if (this._token.length > 0) {
          if (this._rememberMe) {
            this._onCredentialsConfirmed?.({
              tiktok: { msToken: this._token },
            });
          }
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

      // 'm' key toggles remember-me (mnemonic: m = memorise).
      // Handled before printable-char append so it doesn't land in the token.
      if (ch === "m") {
        this._rememberMe = !this._rememberMe;
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
      rememberMe: this._rememberMe,
    };
  }

  renderLines(cols: number): string[] {
    const trunc = (s: string): string => s.slice(0, cols);

    const masked = this._maskToken(this._token);
    const rmBox = this._rememberMe ? "[x]" : "[ ]";

    const lines: string[] = [
      trunc("[ TikTok session ]"),
      trunc(""),
      trunc("Paste ms_token cookie:"),
      trunc(`→ ms_token: ${masked}`),
      trunc(""),
      trunc(`${rmBox} remember me  (m: toggle)`),
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
