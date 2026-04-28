import type { KeyAction } from "../../overlay/types.js";
import type { IDisposable } from "../../pty/types.js";
import { TokenForm } from "./token-form.js";
import type { JsonRpcClient } from "../rpc/client.js";
import type { IAdapter, IPane } from "../types.js";

// ---------------------------------------------------------------------------
// RPC result shapes
// ---------------------------------------------------------------------------

interface ValidateResult {
  readonly status: "ready" | "login_required" | "failed";
  readonly message?: string;
}

interface SetTokenResult {
  readonly status: "ready" | "login_required" | "failed";
  readonly message?: string;
}

interface VideoItem {
  readonly id: string;
  readonly author: string;
  readonly caption: string;
  readonly url: string;
}

interface FeedListResult {
  readonly items: readonly VideoItem[];
}

interface CommentItem {
  readonly from: string;
  readonly text: string;
}

interface FeedCommentsResult {
  readonly available: boolean;
  readonly items: readonly CommentItem[];
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Sub-pane types
// ---------------------------------------------------------------------------

export interface SubPaneRect {
  readonly top: number;
  readonly left: number;
  readonly cols: number;
  readonly rows: number;
}

export interface SubPaneController {
  kill(): void;
  onExit(handler: () => void): IDisposable;
}

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface TikTokForYouAdapterOptions {
  readonly client: JsonRpcClient;
  readonly runSubPane: (url: string, rect: SubPaneRect) => SubPaneController;
}

// ---------------------------------------------------------------------------
// Mode discriminant
// ---------------------------------------------------------------------------

type Mode = "loading" | "token" | "feed" | "comments" | "playing";

// ---------------------------------------------------------------------------
// TikTokForYouAdapter
// ---------------------------------------------------------------------------

export class TikTokForYouAdapter implements IAdapter {
  readonly id = "tiktok-foryou";

  private pane: IPane | undefined;
  private subs: IDisposable[] = [];

  private mode: Mode = "loading";
  private tokenForm: TokenForm = new TokenForm();

  private feed: readonly VideoItem[] = [];
  private selectedIndex = 0;

  private comments: readonly CommentItem[] = [];
  private selectedComment = 0;
  private commentsAvailable = true;
  private commentsMessage: string | undefined;

  private subPane: SubPaneController | undefined;
  private subPaneSub: IDisposable | undefined;

  // The video currently playing (for the header)
  private playingVideo: VideoItem | undefined;

  constructor(private readonly opts: TikTokForYouAdapterOptions) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

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
      this.mode = "token";
      this.tokenForm = new TokenForm();
      this.tokenForm.setMessage("connection error");
      this.repaint();
      return;
    }

    this.handleValidateResult(validateResult);
  }

  async unmount(): Promise<void> {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    if (this.subPaneSub) {
      this.subPaneSub.dispose();
      this.subPaneSub = undefined;
    }
    if (this.subPane) {
      this.subPane.kill();
      this.subPane = undefined;
    }
    this.pane = undefined;
    this.opts.client.dispose();
  }

  // -------------------------------------------------------------------------
  // Validate plumbing
  // -------------------------------------------------------------------------

  private handleValidateResult(result: ValidateResult): void {
    if (result.status === "ready") {
      this.mode = "loading";
      this.repaint();
      void this.loadFeed();
    } else if (result.status === "login_required") {
      this.mode = "token";
      this.tokenForm = new TokenForm();
      this.repaint();
    } else {
      this.mode = "token";
      this.tokenForm = new TokenForm();
      this.tokenForm.setMessage(result.message ?? `validate: ${result.status}`);
      this.repaint();
    }
  }

  private async loadFeed(): Promise<void> {
    try {
      const result = (await this.opts.client.request(
        "feed/list",
        undefined,
      )) as FeedListResult;
      this.feed = result.items;
      this.selectedIndex = 0;
      this.mode = "feed";
      this.repaint();
    } catch {
      this.mode = "token";
      this.tokenForm = new TokenForm();
      this.tokenForm.setMessage("failed to load feed");
      this.repaint();
    }
  }

  private async loadComments(videoId: string): Promise<void> {
    try {
      const result = (await this.opts.client.request("feed/comments", {
        video_id: videoId,
      })) as FeedCommentsResult;
      this.commentsAvailable = result.available;
      this.comments = result.items;
      this.selectedComment = 0;
      this.commentsMessage = result.message;
      this.mode = "comments";
      this.repaint();
    } catch {
      this.commentsAvailable = false;
      this.comments = [];
      this.commentsMessage = "failed to load comments";
      this.mode = "comments";
      this.repaint();
    }
  }

  // -------------------------------------------------------------------------
  // Input routing
  // -------------------------------------------------------------------------

  captureInput(chunk: string): boolean {
    if (this.mode === "token") {
      const action = this.tokenForm.feed(chunk);
      this.repaint();
      if (action === undefined) return true;
      if (action.kind === "submit") {
        const msToken = action.payload.ms_token;
        void this.opts.client
          .request("set_token", { ms_token: msToken })
          .then((raw) => {
            const r = raw as SetTokenResult;
            if (r.status === "ready") {
              this.mode = "loading";
              this.repaint();
              void this.loadFeed();
            } else {
              this.tokenForm.setMessage(r.message ?? "bad token");
              this.repaint();
            }
          })
          .catch(() => {
            this.tokenForm.setMessage("set_token error");
            this.repaint();
          });
      }
      // cancel: stay in token mode
      return true;
    }

    if (this.mode === "feed") {
      for (const ch of chunk) {
        if (ch === "c") {
          const video = this.feed[this.selectedIndex];
          if (video) {
            void this.loadComments(video.id);
          }
          return true;
        }
      }
      return false;
    }

    if (this.mode === "comments") {
      for (const ch of chunk) {
        if (ch === "\x1b") {
          this.mode = "feed";
          this.repaint();
          return true;
        }
      }
      return false;
    }

    if (this.mode === "playing") {
      for (const ch of chunk) {
        if (ch === "q") {
          this.stopSubPane();
          return true;
        }
      }
      return false;
    }

    // loading
    return false;
  }

  handleKey(action: KeyAction): void {
    if (this.mode === "feed") {
      switch (action.kind) {
        case "scroll-down":
          this.selectedIndex = Math.min(
            this.feed.length - 1,
            this.selectedIndex + 1,
          );
          break;
        case "scroll-up":
          this.selectedIndex = Math.max(0, this.selectedIndex - 1);
          break;
        case "scroll-top":
          this.selectedIndex = 0;
          break;
        case "scroll-bottom":
          this.selectedIndex = this.feed.length - 1;
          break;
        default:
          return;
      }
      this.repaint();
      return;
    }

    if (this.mode === "comments") {
      switch (action.kind) {
        case "scroll-down":
          this.selectedComment = Math.min(
            this.comments.length - 1,
            this.selectedComment + 1,
          );
          break;
        case "scroll-up":
          this.selectedComment = Math.max(0, this.selectedComment - 1);
          break;
        case "scroll-top":
          this.selectedComment = 0;
          break;
        case "scroll-bottom":
          this.selectedComment = this.comments.length - 1;
          break;
        default:
          return;
      }
      this.repaint();
    }
  }

  onEnter(): void {
    if (this.mode !== "feed") return;
    const video = this.feed[this.selectedIndex];
    if (!video) return;

    const pane = this.pane;
    if (!pane) return;

    const topHalfRows = Math.max(3, Math.floor(pane.rows * 0.4));
    const subRows = pane.rows - topHalfRows;
    const rect: SubPaneRect = {
      top: pane.topRow + topHalfRows,
      left: 1,
      cols: pane.cols,
      rows: Math.max(1, subRows),
    };

    const controller = this.opts.runSubPane(video.url, rect);
    this.subPane = controller;
    this.playingVideo = video;
    this.mode = "playing";
    this.repaint();

    this.subPaneSub = controller.onExit(() => {
      this.stopSubPane();
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private stopSubPane(): void {
    if (this.subPaneSub) {
      this.subPaneSub.dispose();
      this.subPaneSub = undefined;
    }
    if (this.subPane) {
      this.subPane.kill();
      this.subPane = undefined;
    }
    this.playingVideo = undefined;
    this.mode = "feed";
    this.repaint();
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  private repaint(): void {
    if (!this.pane) return;
    const cols = this.pane.cols;

    if (this.mode === "loading") {
      this.pane.setLines(["TikTok: loading…"]);
      return;
    }

    if (this.mode === "token") {
      this.pane.setLines([...this.tokenForm.renderLines(cols)]);
      return;
    }

    if (this.mode === "feed") {
      const lines: string[] = ["[ TikTok — For You ]", ""];
      if (this.feed.length === 0) {
        lines.push("(no videos)");
      } else {
        for (let i = 0; i < this.feed.length; i++) {
          const video = this.feed[i]!;
          const prefix = i === this.selectedIndex ? "▸ " : "  ";
          const row = `@${video.author}: ${video.caption}`;
          lines.push((prefix + row).slice(0, cols));
        }
      }
      lines.push("");
      lines.push("Enter: play   c: comments   j/k: scroll   q: close");
      this.pane.setLines(lines);
      return;
    }

    if (this.mode === "comments") {
      const lines: string[] = ["[ TikTok — Comments ]", ""];
      if (!this.commentsAvailable) {
        const msg = this.commentsMessage ?? "unavailable";
        lines.push(`(comments unavailable: ${msg})`);
      } else if (this.comments.length === 0) {
        lines.push("(no comments)");
      } else {
        for (let i = 0; i < this.comments.length; i++) {
          const c = this.comments[i]!;
          const prefix = i === this.selectedComment ? "▸ " : "  ";
          const row = `<${c.from}> ${c.text}`;
          lines.push((prefix + row).slice(0, cols));
        }
      }
      lines.push("");
      lines.push("Esc: back   j/k: scroll   q: close");
      this.pane.setLines(lines);
      return;
    }

    if (this.mode === "playing") {
      const video = this.playingVideo;
      const header = video
        ? `▶ Playing: @${video.author}/${video.id}`
        : "▶ Playing";
      this.pane.setLines([header, "", "q: stop"]);
    }
  }
}
