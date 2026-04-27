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

interface ThreadItem {
  readonly thread_id: string;
  readonly title: string;
  readonly last_message: string;
}

interface ThreadsResult {
  readonly items: readonly ThreadItem[];
}

interface MessageItem {
  readonly from: string;
  readonly text: string;
  readonly ts: string;
}

interface MessagesResult {
  readonly items: readonly MessageItem[];
}

interface SendResult {
  readonly ok: boolean;
  readonly message: string | null;
}

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface InstagramDmsAdapterOptions {
  readonly client: JsonRpcClient;
}

// ---------------------------------------------------------------------------
// Mode discriminant
// ---------------------------------------------------------------------------

type Mode = "loading" | "login" | "threads" | "messages" | "input";

// ---------------------------------------------------------------------------
// InstagramDmsAdapter
// ---------------------------------------------------------------------------

export class InstagramDmsAdapter implements IAdapter {
  readonly id = "instagram-dms";

  private pane: IPane | undefined;
  private subs: IDisposable[] = [];

  private mode: Mode = "loading";
  private loginForm: LoginForm = new LoginForm();

  private threads: readonly ThreadItem[] = [];
  private selectedThread = 0;

  private messages: readonly MessageItem[] = [];
  private selectedMessage = 0;
  private currentThreadId: string | undefined;
  private currentThreadTitle = "";

  private inputBuffer = "";

  constructor(private readonly opts: InstagramDmsAdapterOptions) {}

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
      this.loginForm = new LoginForm();
      this.loginForm.setMessage("connection error");
      this.repaint();
      return;
    }

    await this.handleValidateResult(validateResult);
  }

  private async handleValidateResult(result: ValidateResult): Promise<void> {
    if (result.status === "ready") {
      this.mode = "loading";
      this.repaint();
      await this.loadThreads();
    } else if (result.status === "login_required") {
      this.mode = "login";
      this.loginForm = new LoginForm();
      this.repaint();
    } else {
      // "failed" | "2fa_required" or anything unexpected
      this.mode = "login";
      this.loginForm = new LoginForm();
      if (result.message) {
        this.loginForm.setMessage(result.message);
      } else {
        this.loginForm.setMessage(`validate: ${result.status}`);
      }
      this.repaint();
    }
  }

  private async loadThreads(): Promise<void> {
    try {
      const result = (await this.opts.client.request(
        "dms/threads",
        undefined,
      )) as ThreadsResult;
      this.threads = result.items;
      this.selectedThread = 0;
      this.mode = "threads";
      this.repaint();
    } catch {
      this.mode = "login";
      this.loginForm = new LoginForm();
      this.loginForm.setMessage("failed to load threads");
      this.repaint();
    }
  }

  private async loadMessages(threadId: string): Promise<void> {
    try {
      const result = (await this.opts.client.request("dms/messages", {
        thread_id: threadId,
      })) as MessagesResult;
      this.messages = result.items;
      this.selectedMessage = 0;
      this.mode = "messages";
      this.repaint();
    } catch {
      this.mode = "threads";
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

    if (this.mode === "messages") {
      for (const ch of chunk) {
        if (ch === "i") {
          this.mode = "input";
          this.inputBuffer = "";
          this.repaint();
          return true;
        }
        if (ch === "\x1b") {
          this.mode = "threads";
          this.repaint();
          return true;
        }
      }
      return false;
    }

    if (this.mode === "input") {
      for (const ch of chunk) {
        const code = ch.codePointAt(0) ?? 0;
        if (ch === "\r" || ch === "\n") {
          const textToSend = this.inputBuffer;
          const threadId = this.currentThreadId;
          if (threadId !== undefined) {
            void this.opts.client
              .request("dms/send", { thread_id: threadId, text: textToSend })
              .then((raw) => {
                const result = raw as SendResult;
                if (result.ok) {
                  this.inputBuffer = "";
                  this.mode = "messages";
                  this.repaint();
                  void this.loadMessages(threadId);
                }
              })
              .catch(() => {
                this.mode = "messages";
                this.repaint();
              });
          }
        } else if (ch === "\x7f") {
          if (this.inputBuffer.length > 0) {
            this.inputBuffer = this.inputBuffer.slice(0, -1);
          }
          this.repaint();
        } else if (ch === "\x1b") {
          this.mode = "messages";
          this.inputBuffer = "";
          this.repaint();
        } else if (code >= 0x20 && code <= 0x7e) {
          this.inputBuffer += ch;
          this.repaint();
        }
      }
      return true;
    }

    return false;
  }

  private async handleLoginResult(result: LoginResult): Promise<void> {
    if (result.status === "ready") {
      this.mode = "loading";
      this.repaint();
      await this.loadThreads();
    } else if (result.status === "2fa_required") {
      this.loginForm.setRequires2fa(true);
      this.repaint();
    } else if (result.status === "login_required") {
      this.loginForm = new LoginForm();
      this.mode = "login";
      this.repaint();
    } else {
      // "failed"
      if (result.message) {
        this.loginForm.setMessage(result.message);
      } else {
        this.loginForm.setMessage("login failed");
      }
      this.repaint();
    }
  }

  handleKey(action: KeyAction): void {
    if (this.mode === "threads") {
      switch (action.kind) {
        case "scroll-down":
          this.selectedThread = Math.min(
            this.threads.length - 1,
            this.selectedThread + 1,
          );
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

    if (this.mode === "messages") {
      switch (action.kind) {
        case "scroll-down":
          this.selectedMessage = Math.min(
            this.messages.length - 1,
            this.selectedMessage + 1,
          );
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
    if (this.mode !== "threads") return;
    const thread = this.threads[this.selectedThread];
    if (!thread) return;
    this.currentThreadId = thread.thread_id;
    this.currentThreadTitle = thread.title;
    void this.loadMessages(thread.thread_id);
  }

  private repaint(): void {
    if (!this.pane) return;
    const cols = this.pane.cols;

    if (this.mode === "loading") {
      this.pane.setLines(["instagram (dms): loading…"]);
      return;
    }

    if (this.mode === "login") {
      this.pane.setLines([
        "[ Instagram login ]",
        "",
        ...this.loginForm.renderLines(cols),
      ]);
      return;
    }

    if (this.mode === "threads") {
      const lines: string[] = ["[ DMs — Threads ]", ""];
      if (this.threads.length === 0) {
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
      lines.push("Enter: open thread   j/k: scroll   q: close");
      this.pane.setLines(lines);
      return;
    }

    if (this.mode === "messages" || this.mode === "input") {
      const lines: string[] = [`[ DMs — ${this.currentThreadTitle} ]`, ""];
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
      lines.push("i: reply   Esc: back   j/k: scroll   q: close");

      if (this.mode === "input") {
        lines.push((`reply: ${this.inputBuffer}_`).slice(0, cols));
      }

      this.pane.setLines(lines);
    }
  }
}
