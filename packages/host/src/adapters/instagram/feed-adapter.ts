import type { LimboSecrets } from "../../config/secrets.js";
import type { KeyAction } from "../../overlay/types.js";
import type { IDisposable } from "../../pty/types.js";
import { BootstrapPanel } from "../bootstrap-panel.js";
import type { JsonRpcClient } from "../rpc/client.js";
import type { IAdapter, IPane } from "../types.js";
import { LoginForm } from "./login-form.js";
import type { SharedInstagramSidecar } from "./shared-sidecar.js";

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

interface FeedItem {
  readonly pk: string;
  readonly code: string;
  readonly author: string;
  readonly caption: string;
  readonly url: string;
}

interface FeedListResult {
  readonly items: readonly FeedItem[];
}

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface InstagramFeedAdapterOptions {
  readonly client: JsonRpcClient;
  readonly runDetached: (url: string) => Promise<void>;
  readonly onCredentialsConfirmed?: (secrets: Partial<LimboSecrets>) => void;
  /**
   * Shared sidecar reference used for bootstrap wiring. When provided,
   * mount() will run the venv bootstrap (if needed) before calling RPC,
   * streaming progress into a BootstrapPanel.
   */
  readonly igSidecar?: SharedInstagramSidecar;
}

// ---------------------------------------------------------------------------
// Mode discriminant
// ---------------------------------------------------------------------------

type Mode = "loading" | "login" | "list";

// ---------------------------------------------------------------------------
// InstagramFeedAdapter
// ---------------------------------------------------------------------------

export class InstagramFeedAdapter implements IAdapter {
  readonly id = "instagram-feed";

  private pane: IPane | undefined;
  private subs: IDisposable[] = [];

  private mode: Mode = "loading";
  // Properly initialized in mount() via _makeLoginForm(); placeholder avoids undefined.
  private form: LoginForm = new LoginForm();
  private items: readonly FeedItem[] = [];
  private selected = 0;

  constructor(private readonly opts: InstagramFeedAdapterOptions) {}

  async mount(pane: IPane): Promise<void> {
    this.pane = pane;
    this.form = this._makeLoginForm();
    this.subs.push(pane.on("resize", () => this.repaint()));

    // ---------------------------------------------------------------------------
    // Bootstrap phase: run only when a shared sidecar with a runner is wired in
    // and the venv has not been prepared yet.
    // ---------------------------------------------------------------------------
    const runner = this.opts.igSidecar?.runner;
    if (runner && runner.status !== "ready") {
      const panel = new BootstrapPanel();
      panel.attach(pane);
      panel.start("Preparing dependencies for Instagram…");

      const unsubProgress = runner.onProgress((p) => {
        switch (p.phase) {
          case "creating-venv":
            panel.update("creating virtual environment…");
            break;
          case "installing-package":
            panel.update("installing instagrapi…");
            break;
          case "writing-manifest":
            panel.update("finalising installation…");
            break;
          case "done":
            panel.update("done");
            break;
        }
      });

      try {
        await this.opts.igSidecar?.ensureBootstrap();
      } catch (err) {
        unsubProgress();
        const msg = err instanceof Error ? err.message : String(err);
        panel.error(msg);
        return; // stay on error screen; user navigates away with q/h/l
      }
      unsubProgress();
      // fall through to RPC mount below
    }

    let validateResult: ValidateResult;
    try {
      validateResult = (await this.opts.client.request("validate", undefined)) as ValidateResult;
    } catch {
      this.mode = "login";
      this.form = this._makeLoginForm();
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
      await this.loadFeedList();
    } else if (result.status === "login_required") {
      this.mode = "login";
      this.form = this._makeLoginForm();
      this.repaint();
    } else {
      // "failed" | "2fa_required" or anything unexpected
      this.mode = "login";
      this.form = this._makeLoginForm();
      if (result.message) {
        this.form.setMessage(result.message);
      } else {
        this.form.setMessage(`validate: ${result.status}`);
      }
      this.repaint();
    }
  }

  private async loadFeedList(): Promise<void> {
    try {
      const result = (await this.opts.client.request("feed/list", undefined)) as FeedListResult;
      this.items = result.items;
      this.selected = 0;
      this.mode = "list";
      this.repaint();
    } catch {
      this.mode = "login";
      this.form = this._makeLoginForm();
      this.form.setMessage("failed to load feed");
      this.repaint();
    }
  }

  async unmount(): Promise<void> {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.pane = undefined;
    // The JsonRpcClient is owned by the shared sidecar and must not be
    // disposed here. The registry's dispose() path tears it down via
    // SharedInstagramSidecar.dispose().
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
      await this.loadFeedList();
    } else if (result.status === "2fa_required") {
      this.form.setRequires2fa(true);
      this.repaint();
    } else if (result.status === "login_required") {
      this.form = this._makeLoginForm();
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

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private _makeLoginForm(): LoginForm {
    return new LoginForm({
      onCredentialsConfirmed: (creds) => this.opts.onCredentialsConfirmed?.({ instagram: creds }),
    });
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
      this.pane.setLines(["instagram (feed): loading…"]);
      return;
    }

    if (this.mode === "login") {
      this.pane.setLines(["[ Instagram login ]", "", ...this.form.renderLines(this.pane.cols)]);
      return;
    }

    // list mode
    const cols = this.pane.cols;
    const lines: string[] = ["[ Feed ]", ""];

    if (this.items.length === 0) {
      lines.push("(no posts)");
    } else {
      for (let i = 0; i < this.items.length; i++) {
        const item = this.items[i]!;
        const prefix = i === this.selected ? "▸ " : "  ";
        const row = `@${item.author}: ${item.caption}`;
        lines.push((prefix + row).slice(0, cols));
      }
    }

    lines.push("");
    lines.push("Enter: open in carbonyl   j/k: scroll   q: close");

    this.pane.setLines(lines);
  }
}
