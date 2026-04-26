import { translateExit } from "./pty/exit-code.js";
import type { IDisposable, IPty, PtyFactory } from "./pty/types.js";

interface WrapperStdin extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
}

interface WrapperStdout {
  readonly columns?: number;
  readonly rows?: number;
  write(chunk: string): boolean;
}

export interface RunWrapperOptions {
  readonly claudeBin: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdin: WrapperStdin;
  readonly stdout: WrapperStdout;
  readonly process: NodeJS.EventEmitter;
  readonly ptyFactory: PtyFactory;
}

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export function runWrapper(opts: RunWrapperOptions): Promise<number> {
  const cols = opts.stdout.columns ?? DEFAULT_COLS;
  const rows = opts.stdout.rows ?? DEFAULT_ROWS;
  const pty: IPty = opts.ptyFactory({
    file: opts.claudeBin,
    args: opts.argv,
    env: opts.env,
    cwd: opts.cwd,
    cols,
    rows,
  });

  const disposables: IDisposable[] = [];

  const onStdinData = (chunk: Buffer | string): void => {
    pty.write(typeof chunk === "string" ? chunk : chunk.toString("binary"));
  };
  opts.stdin.on("data", onStdinData);

  const onWinch = (): void => {
    const c = opts.stdout.columns ?? DEFAULT_COLS;
    const r = opts.stdout.rows ?? DEFAULT_ROWS;
    pty.resize(c, r);
  };
  opts.process.on("SIGWINCH", onWinch);

  const signalHandlers = new Map<ForwardedSignal, () => void>();
  for (const sig of FORWARDED_SIGNALS) {
    const handler = (): void => pty.kill(sig);
    signalHandlers.set(sig, handler);
    opts.process.on(sig, handler);
  }

  disposables.push(
    pty.onData((data) => {
      opts.stdout.write(data);
    }),
  );

  return new Promise<number>((resolve) => {
    disposables.push(
      pty.onExit((event) => {
        opts.stdin.off("data", onStdinData);
        opts.process.off("SIGWINCH", onWinch);
        for (const [sig, handler] of signalHandlers) {
          opts.process.off(sig, handler);
        }
        for (const d of disposables) d.dispose();
        resolve(translateExit(event));
      }),
    );
  });
}
