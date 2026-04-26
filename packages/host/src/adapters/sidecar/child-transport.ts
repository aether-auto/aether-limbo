import type { ChildProcess } from "node:child_process";
import type { IDisposable } from "../../pty/types.js";
import type { ITransport, TransportExit } from "../rpc/transport.js";

export type SpawnLike = (
  file: string,
  args: readonly string[],
  opts: { env: NodeJS.ProcessEnv; cwd: string },
) => ChildProcess;

export interface ChildProcessTransportOptions {
  readonly pythonExe: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly spawn: SpawnLike;
}

export class ChildProcessTransport implements ITransport {
  private readonly child: ChildProcess;
  private readonly dataListeners: Array<(chunk: string) => void> = [];
  private readonly exitListeners: Array<(e: TransportExit) => void> = [];

  constructor(opts: ChildProcessTransportOptions) {
    this.child = opts.spawn(opts.pythonExe, opts.args, { env: opts.env, cwd: opts.cwd });
    this.child.stdout?.on("data", (buf: Buffer | string) => {
      const s = typeof buf === "string" ? buf : buf.toString("utf8");
      for (const l of this.dataListeners) l(s);
    });
    this.child.on("exit", (code, signal) => {
      const ex: TransportExit = { code, signal };
      for (const l of this.exitListeners) l(ex);
    });
  }

  write(chunk: string): void {
    this.child.stdin?.write(chunk);
  }

  onData(listener: (chunk: string) => void): IDisposable {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        const i = this.dataListeners.indexOf(listener);
        if (i >= 0) this.dataListeners.splice(i, 1);
      },
    };
  }

  onExit(listener: (e: TransportExit) => void): IDisposable {
    this.exitListeners.push(listener);
    return {
      dispose: () => {
        const i = this.exitListeners.indexOf(listener);
        if (i >= 0) this.exitListeners.splice(i, 1);
      },
    };
  }

  close(): void {
    this.child.kill("SIGTERM");
  }
}
