import type { KeyAction } from "../../overlay/types.js";
import type { IDisposable } from "../../pty/types.js";
import { LoginForm } from "../instagram/login-form.js";
import type { JsonRpcClient } from "../rpc/client.js";
import type { IAdapter, IPane } from "../types.js";

// ---------------------------------------------------------------------------
// RPC result shapes (mirror twitter-home sidecar — see packages/sidecars/.../home.py)
// ---------------------------------------------------------------------------

interface ValidateResult {
  readonly status: "ready" | "login_required" | "failed" | "2fa_required";
  readonly message?: string;
}

interface LoginResult {
  readonly status: "ready" | "login_required" | "2fa_required" | "failed";
  readonly message?: string;
}

interface TweetItem {
  readonly id: string;
  readonly author: string;
  readonly text: string;
  readonly url: string;
}

interface TimelineResult {
  readonly items: readonly TweetItem[];
}

interface ActionResult {
  readonly ok: boolean;
  readonly message: string | null;
}

interface DmThreadItem {
  readonly thread_id: string;
  readonly title: string;
  readonly last_message: string;
}

interface DmThreadsResult {
  readonly available: boolean;
  readonly items: readonly DmThreadItem[];
  readonly message?: string;
}

interface DmMessageItem {
  readonly from: string;
  readonly text: string;
  readonly ts: string;
}

interface DmMessagesResult {
  readonly available: boolean;
  readonly items: readonly DmMessageItem[];
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface TwitterHomeAdapterOptions {
  readonly client: JsonRpcClient;
  readonly runDetached: (url: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Mode discriminant
// ---------------------------------------------------------------------------

type Mode = "loading" | "login" | "timeline" | "reply" | "dms_threads" | "dms_messages";

// ---------------------------------------------------------------------------
// TwitterHomeAdapter
// ---------------------------------------------------------------------------

export class TwitterHomeAdapter implements IAdapter {
  readonly id = "twitter-home";

  private pane: IPane | undefined;
  private subs: IDisposable[] = [];

  private mode: Mode = "loading";
  private loginForm: LoginForm = new LoginForm();

  private timeline: readonly TweetItem[] = [];
  private selectedTweet = 0;

  private replyBuffer = "";
  private replyTarget: TweetItem | undefined;
  private statusMessage: string | undefined;

  private threads: readonly DmThreadItem[] = [];
  private selectedThread = 0;
  private dmsAvailable = true;
  private dmsMessage: string | undefined;

  private messages: readonly DmMessageItem[] = [];
  private selectedMessage = 0;
  private currentThreadTitle = "";

  constructor(private readonly opts: TwitterHomeAdapterOptions) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async mount(pane: IPane): Promise<void> {
    this.pane = pane;
    this.subs.push(pane.on("resize", () => this.repaint()));

    let validateResult: ValidateResult;
    try {
      validateResult = (await this.opts.client.request("validate", undefined)) as ValidateResult;
    } catch {
      this.mode = "login";
      this.loginForm = new LoginForm();
      this.loginForm.setMessage("connection error");
      this.repaint();
      return;
    }

    await this.handleValidateResult(validateResult);
  }

  async unmount(): Promise<void> {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.pane = undefined;
    this.opts.client.dispose();
  }

  // -------------------------------------------------------------------------
  // Validate / login plumbing
  // -------------------------------------------------------------------------

  private async handleValidateResult(result: ValidateResult): Promise<void> {
    if (result.status === "ready") {
      this.mode = "loading";
      this.repaint();
      await this.loadTimeline();
    } else if (result.status === "login_required") {
      this.mode = "login";
      this.loginForm = new LoginForm();
      this.repaint();
    } else {
      this.mode = "login";
      this.loginForm = new LoginForm();
      this.loginForm.setMessage(result.message ?? `validate: ${result.status}`);
      this.repaint();
    }
  }

  private async handleLoginResult(result: LoginResult): Promise<void> {
    if (result.status === "ready") {
      this.mode = "loading";
      this.repaint();
      await this.loadTimeline();
    } else if (result.status === "2fa_required") {
      this.loginForm.setRequires2fa(true);
      this.repaint();
    } else if (result.status === "login_required") {
      this.loginForm = new LoginForm();
      this.mode = "login";
      this.repaint();
    } else {
      this.loginForm.setMessage(result.message ?? "login failed");
      this.repaint();
    }
  }

  private async loadTimeline(): Promise<void> {
    try {
      const result = (await this.opts.client.request("timeline/list", undefined)) as TimelineResult;
      this.timeline = result.items;
      this.selectedTweet = 0;
      this.mode = "timeline";
      this.repaint();
    } catch {
      this.mode = "login";
      this.loginForm = new LoginForm();
      this.loginForm.setMessage("failed to load timeline");
      this.repaint();
    }
  }

  private async loadDmsThreads(): Promise<void> {
    try {
      const result = (await this.opts.client.request("dms/threads", undefined)) as DmThreadsResult;
      this.dmsAvailable = result.available;
      this.threads = result.items;
      this.selectedThread = 0;
      this.dmsMessage = result.message;
      this.mode = "dms_threads";
      this.repaint();
    } catch {
      this.dmsAvailable = false;
      this.threads = [];
      this.dmsMessage = "DMs request failed";
      this.mode = "dms_threads";
      this.repaint();
    }
  }

  private async loadDmsMessages(threadId: string): Promise<void> {
    try {
      const result = (await this.opts.client.request("dms/messages", {
        thread_id: threadId,
      })) as DmMessagesResult;
      this.dmsAvailable = result.available;
      this.messages = result.items;
      this.selectedMessage = 0;
      this.mode = "dms_messages";
      this.repaint();
    } catch {
      this.mode = "dms_threads";
      this.repaint();
    }
  }

  // -------------------------------------------------------------------------
  // Input routing
  // -------------------------------------------------------------------------

  captureInput(chunk: string): boolean {
    if (this.mode === "login") {
      const action = this.loginForm.feed(chunk);
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
            this.loginForm.setMessage("login error");
            this.repaint();
          });
      } else if (action.kind === "submit2fa") {
        void this.opts.client
          .request("login_2fa", { code: action.payload.code })
          .then((raw) => this.handleLoginResult(raw as LoginResult))
          .catch(() => {
            this.loginForm.setMessage("2fa error");
            this.repaint();
          });
      }
      return true;
    }

    if (this.mode === "timeline") {
      // Consume only the X-specific verbs so vim-style keymap (h/j/k/g/G/q)
      // continues to work for everything else.
      let consumed = false;
      for (const ch of chunk) {
        if (ch === "l") {
          this.fireLike();
          consumed = true;
        } else if (ch === "r") {
          this.enterReplyMode();
          consumed = true;
        } else if (ch === "d") {
          this.statusMessage = undefined;
          this.mode = "loading";
          this.repaint();
          void this.loadDmsThreads();
          consumed = true;
        }
      }
      return consumed;
    }

    if (this.mode === "reply") {
      for (const ch of chunk) {
        const code = ch.codePointAt(0) ?? 0;
        if (ch === "\r" || ch === "\n") {
          const text = this.replyBuffer;
          const target = this.replyTarget;
          if (target !== undefined) {
            void this.opts.client
              .request("timeline/reply", {
                tweet_id: target.id,
                text,
              })
              .then((raw) => {
                const r = raw as ActionResult;
                this.statusMessage = r.ok ? "reply sent" : `reply failed: ${r.message ?? ""}`;
                this.replyBuffer = "";
                this.mode = "timeline";
                this.repaint();
              })
              .catch(() => {
                this.statusMessage = "reply error";
                this.mode = "timeline";
                this.repaint();
              });
          } else {
            this.replyBuffer = "";
            this.mode = "timeline";
            this.repaint();
          }
        } else if (ch === "\x7f") {
          if (this.replyBuffer.length > 0) {
            this.replyBuffer = this.replyBuffer.slice(0, -1);
          }
          this.repaint();
        } else if (ch === "\x1b") {
          this.replyBuffer = "";
          this.mode = "timeline";
          this.repaint();
        } else if (code >= 0x20 && code <= 0x7e) {
          this.replyBuffer += ch;
          this.repaint();
        }
      }
      return true;
    }

    if (this.mode === "dms_threads") {
      let consumed = false;
      for (const ch of chunk) {
        if (ch === "t") {
          this.mode = "timeline";
          this.repaint();
          consumed = true;
        }
      }
      return consumed;
    }

    if (this.mode === "dms_messages") {
      for (const ch of chunk) {
        if (ch === "\x1b") {
          this.mode = "dms_threads";
          this.repaint();
          return true;
        }
      }
      return false;
    }

    return false;
  }

  handleKey(action: KeyAction): void {
    if (this.mode === "timeline") {
      switch (action.kind) {
        case "scroll-down":
          this.selectedTweet = Math.min(this.timeline.length - 1, this.selectedTweet + 1);
          break;
        case "scroll-up":
          this.selectedTweet = Math.max(0, this.selectedTweet - 1);
          break;
        case "scroll-top":
          this.selectedTweet = 0;
          break;
        case "scroll-bottom":
          this.selectedTweet = this.timeline.length - 1;
          break;
        default:
          return;
      }
      this.repaint();
      return;
    }

    if (this.mode === "dms_threads") {
      switch (action.kind) {
        case "scroll-down":
          this.selectedThread = Math.min(this.threads.length - 1, this.selectedThread + 1);
          break;
        case "scroll-up":
          this.selectedThread = Math.max(0, this.selectedThread - 1);
          break;
        case "scroll-top":
          this.selectedThread = 0;
          break;
        case "scroll-bottom":
          this.selectedThread = this.threads.length - 1;
          break;
        default:
          return;
      }
      this.repaint();
      return;
    }

    if (this.mode === "dms_messages") {
      switch (action.kind) {
        case "scroll-down":
          this.selectedMessage = Math.min(this.messages.length - 1, this.selectedMessage + 1);
          break;
        case "scroll-up":
          this.selectedMessage = Math.max(0, this.selectedMessage - 1);
          break;
        case "scroll-top":
          this.selectedMessage = 0;
          break;
        case "scroll-bottom":
          this.selectedMessage = this.messages.length - 1;
          break;
        default:
          return;
      }
      this.repaint();
    }
  }

  onEnter(): void {
    if (this.mode === "timeline") {
      const item = this.timeline[this.selectedTweet];
      if (!item || !item.url) return;
      void this.opts.runDetached(item.url);
      return;
    }
    if (this.mode === "dms_threads" && this.dmsAvailable) {
      const t = this.threads[this.selectedThread];
      if (!t) return;
      this.currentThreadTitle = t.title;
      void this.loadDmsMessages(t.thread_id);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private fireLike(): void {
    const tweet = this.timeline[this.selectedTweet];
    if (!tweet) return;
    void this.opts.client
      .request("timeline/like", { tweet_id: tweet.id })
      .then((raw) => {
        const r = raw as ActionResult;
        this.statusMessage = r.ok ? `liked @${tweet.author}` : `like failed: ${r.message ?? ""}`;
        this.repaint();
      })
      .catch(() => {
        this.statusMessage = "like error";
        this.repaint();
      });
  }

  private enterReplyMode(): void {
    const tweet = this.timeline[this.selectedTweet];
    if (!tweet) return;
    this.replyTarget = tweet;
    this.replyBuffer = "";
    this.statusMessage = undefined;
    this.mode = "reply";
    this.repaint();
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  private repaint(): void {
    if (!this.pane) return;
    const cols = this.pane.cols;

    if (this.mode === "loading") {
      this.pane.setLines(["x: loading…"]);
      return;
    }

    if (this.mode === "login") {
      this.pane.setLines(["[ X login ]", "", ...this.loginForm.renderLines(cols)]);
      return;
    }

    if (this.mode === "timeline" || this.mode === "reply") {
      const lines: string[] = ["[ X — Home ]", ""];
      if (this.timeline.length === 0) {
        lines.push("(no tweets)");
      } else {
        for (let i = 0; i < this.timeline.length; i++) {
          const tweet = this.timeline[i]!;
          const prefix = i === this.selectedTweet ? "▸ " : "  ";
          const row = `@${tweet.author}: ${tweet.text}`;
          lines.push((prefix + row).slice(0, cols));
        }
      }
      lines.push("");
      lines.push("Enter: open  l: like  r: reply  d: dms  j/k: scroll  q: close");
      if (this.statusMessage !== undefined) {
        lines.push(this.statusMessage.slice(0, cols));
      }
      if (this.mode === "reply" && this.replyTarget) {
        lines.push("");
        lines.push(`reply to @${this.replyTarget.author}: ${this.replyBuffer}_`.slice(0, cols));
        lines.push("Esc: cancel   Enter: send");
      }
      this.pane.setLines(lines);
      return;
    }

    if (this.mode === "dms_threads") {
      const lines: string[] = ["[ X — DMs ]", ""];
      if (!this.dmsAvailable) {
        lines.push("DMs require X Premium — unavailable on this account.");
        if (this.dmsMessage) {
          lines.push(`(${this.dmsMessage})`);
        }
      } else if (this.threads.length === 0) {
        lines.push("(no threads)");
      } else {
        for (let i = 0; i < this.threads.length; i++) {
          const thread = this.threads[i]!;
          const prefix = i === this.selectedThread ? "▸ " : "  ";
          const row = `${thread.title}: ${thread.last_message}`;
          lines.push((prefix + row).slice(0, cols));
        }
      }
      lines.push("");
      lines.push("Enter: open thread   t: timeline   j/k: scroll   q: close");
      this.pane.setLines(lines);
      return;
    }

    if (this.mode === "dms_messages") {
      const lines: string[] = [`[ X — ${this.currentThreadTitle} ]`, ""];
      if (this.messages.length === 0) {
        lines.push("(no messages)");
      } else {
        for (let i = 0; i < this.messages.length; i++) {
          const msg = this.messages[i]!;
          const prefix = i === this.selectedMessage ? "▸ " : "  ";
          const row = `<${msg.from}> ${msg.text}`;
          lines.push((prefix + row).slice(0, cols));
        }
      }
      lines.push("");
      lines.push("Esc: back   j/k: scroll   q: close");
      this.pane.setLines(lines);
    }
  }
}
