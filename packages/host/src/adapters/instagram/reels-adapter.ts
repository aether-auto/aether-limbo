import type { KeyAction } from "../../overlay/types.js";
import type { IDisposable } from "../../pty/types.js";
import { LoginForm } from "./login-form.js";
import type { JsonRpcClient } from "../rpc/client.js";
import type { IAdapter, IPane } from "../types.js";

// ---------------------------------------------------------------------------
// RPC result shapes
// ---------------------------------------------------------------------------

interface ValidateResult {
  readonly status: "ready" | "login_required" | "failed" | "2fa_required";
  readonly message?: string;
}

interface LoginResult {
  readonly status: "ready" | "login_required" | "2fa_required" | "failed";
  readonly message?: string;
}

interface ReelItem {
  readonly pk: string;
  readonly code: string;
  readonly caption: string;
  readonly url: string;
}

interface MediaListResult {
  readonly items: readonly ReelItem[];
}

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface InstagramReelsAdapterOptions {
  readonly client: JsonRpcClient;
  readonly runDetached: (url: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Mode discriminant
// ---------------------------------------------------------------------------

type Mode = "loading" | "login" | "list";

// ---------------------------------------------------------------------------
// InstagramReelsAdapter
// ---------------------------------------------------------------------------

export class InstagramReelsAdapter implements IAdapter {
  readonly id = "instagram-reels";

  private pane: IPane | undefined;
  private subs: IDisposable[] = [];

  private mode: Mode = "loading";
  private form: LoginForm = new LoginForm();
  private items: readonly ReelItem[] = [];
  private selected = 0;

  constructor(private readonly opts: InstagramReelsAdapterOptions) {}

  async mount(pane: IPane): Promise<void> {
    this.pane = pane;
    this.subs.push(pane.on("resize", () => this.repaint()));

    let validateResult: ValidateResult;
    try {
      validateResult = (await this.opts.client.request(
        "validate",
        undefined,
      )) as ValidateResult;
    } catch {
      this.mode = "login";
      this.form = new LoginForm();
      this.form.setMessage("connection error");
      this.repaint();
      return;
    }

    await this.handleValidateResult(validateResult);
  }

  private async handleValidateResult(result: ValidateResult): Promise<void> {
    if (result.status === "ready") {
      this.mode = "loading";
      this.repaint();
      await this.loadMediaList();
    } else if (result.status === "login_required") {
      this.mode = "login";
      this.form = new LoginForm();
      this.repaint();
    } else {
      // "failed" | "2fa_required" or anything unexpected
      this.mode = "login";
      this.form = new LoginForm();
      if (result.message) {
        this.form.setMessage(result.message);
      } else {
        this.form.setMessage(`validate: ${result.status}`);
      }
      this.repaint();
    }
  }

  private async loadMediaList(): Promise<void> {
    try {
      const result = (await this.opts.client.request(
        "media/list",
        undefined,
      )) as MediaListResult;
      this.items = result.items;
      this.selected = 0;
      this.mode = "list";
      this.repaint();
    } catch {
      this.mode = "login";
      this.form = new LoginForm();
      this.form.setMessage("failed to load reels");
      this.repaint();
    }
  }

  async unmount(): Promise<void> {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.pane = undefined;
    this.opts.client.dispose();
  }

  captureInput(chunk: string): boolean {
    if (this.mode !== "login") return false;

    const action = this.form.feed(chunk);
    this.repaint();

    if (action === undefined) return true;

    if (action.kind === "submit") {
      void this.opts.client
        .request("login", {
          username: action.payload.username,
          password: action.payload.password,
        })
        .then((raw) => this.handleLoginResult(raw as LoginResult))
        .catch(() => {
          this.form.setMessage("login error");
          this.repaint();
        });
    } else if (action.kind === "submit2fa") {
      void this.opts.client
        .request("login_2fa", { code: action.payload.code })
        .then((raw) => this.handleLoginResult(raw as LoginResult))
        .catch(() => {
          this.form.setMessage("2fa error");
          this.repaint();
        });
    }

    return true;
  }

  private async handleLoginResult(result: LoginResult): Promise<void> {
    if (result.status === "ready") {
      this.mode = "loading";
      this.repaint();
      await this.loadMediaList();
    } else if (result.status === "2fa_required") {
      this.form.setRequires2fa(true);
      this.repaint();
    } else if (result.status === "login_required") {
      this.form = new LoginForm();
      this.mode = "login";
      this.repaint();
    } else {
      // "failed"
      if (result.message) {
        this.form.setMessage(result.message);
      } else {
        this.form.setMessage("login failed");
      }
      this.repaint();
    }
  }

  handleKey(action: KeyAction): void {
    if (this.mode !== "list") return;

    switch (action.kind) {
      case "scroll-down":
        this.selected = Math.min(this.items.length - 1, this.selected + 1);
        break;
      case "scroll-up":
        this.selected = Math.max(0, this.selected - 1);
        break;
      case "scroll-top":
        this.selected = 0;
        break;
      case "scroll-bottom":
        this.selected = this.items.length - 1;
        break;
      default:
        return;
    }

    this.repaint();
  }

  onEnter(): void {
    if (this.mode !== "list") return;
    const item = this.items[this.selected];
    if (!item) return;
    void this.opts.runDetached(item.url);
  }

  private repaint(): void {
    if (!this.pane) return;

    if (this.mode === "loading") {
      this.pane.setLines(["instagram (reels): loading…"]);
      return;
    }

    if (this.mode === "login") {
      this.pane.setLines([
        "[ Instagram login ]",
        "",
        ...this.form.renderLines(this.pane.cols),
      ]);
      return;
    }

    // list mode
    const cols = this.pane.cols;
    const lines: string[] = ["[ Reels ]", ""];

    if (this.items.length === 0) {
      lines.push("(no reels)");
    } else {
      for (let i = 0; i < this.items.length; i++) {
        const item = this.items[i]!;
        const prefix = i === this.selected ? "▸ " : "  ";
        // 2-char prefix, leave cols-4 for caption (2 prefix + 2 margin safety)
        const caption = item.caption.slice(0, cols - 4) || "(no caption)";
        lines.push(prefix + caption);
      }
    }

    lines.push("");
    lines.push("Enter: open in carbonyl   j/k: scroll   q: close");

    this.pane.setLines(lines);
  }
}
