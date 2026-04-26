import type { KeyAction } from "../overlay/types.js";
import type { IDisposable } from "../pty/types.js";
import type { JsonRpcClient } from "./rpc/client.js";
import type { IAdapter, IPane } from "./types.js";

export interface EchoAdapterOptions {
  readonly client: JsonRpcClient;
}

interface BodyUpdateParams {
  readonly lines: readonly string[];
}

export class EchoAdapter implements IAdapter {
  readonly id = "echo";
  private pane: IPane | undefined;
  private subs: IDisposable[] = [];
  private roundTrips = 0;
  private lines: readonly string[] = [];

  constructor(private readonly opts: EchoAdapterOptions) {}

  async mount(pane: IPane): Promise<void> {
    this.pane = pane;
    this.subs.push(
      this.opts.client.on("body/update", (params) => {
        const p = params as BodyUpdateParams | undefined;
        if (p && Array.isArray(p.lines)) {
          this.lines = p.lines;
          this.repaint();
        }
      }),
    );
    this.subs.push(pane.on("resize", () => this.repaint()));
  }

  async unmount(): Promise<void> {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.pane = undefined;
    this.opts.client.dispose();
  }

  handleKey(action: KeyAction): void {
    if (action.kind !== "scroll-down") return;
    void this.opts.client
      .request("ping", undefined)
      .then((result) => {
        if (result === "pong") {
          this.roundTrips++;
          this.repaint();
        }
      })
      .catch(() => {
        this.lines = ["echo: sidecar error"];
        this.repaint();
      });
  }

  private repaint(): void {
    if (!this.pane) return;
    const base = this.lines.length > 0 ? [...this.lines] : ["echo sidecar ready"];
    base.push(`round-trips: ${this.roundTrips}`);
    this.pane.setLines(base);
  }
}
