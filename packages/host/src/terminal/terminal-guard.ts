import type { EventEmitter } from "node:events";

interface RawCapableStream {
  isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
}

interface TerminalGuardDeps {
  readonly stdin: RawCapableStream;
  readonly process: EventEmitter;
  readonly exit: (code: number) => void;
}

export class TerminalGuard {
  private entered = false;
  private wasTTY = false;
  private readonly onExit: () => void;
  private readonly onUncaught: (err: unknown) => void;

  constructor(private readonly deps: TerminalGuardDeps) {
    this.onExit = () => this.restore();
    this.onUncaught = (err) => {
      this.restore();
      process.stderr.write(`limbo: fatal: ${stringifyError(err)}\n`);
      this.deps.exit(1);
    };
  }

  enter(): void {
    if (this.entered) return;
    this.entered = true;
    const { stdin, process: proc } = this.deps;
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
      this.wasTTY = true;
    }
    proc.on("exit", this.onExit);
    proc.on("uncaughtException", this.onUncaught);
  }

  restore(): void {
    if (!this.entered) return;
    this.entered = false;
    const { stdin, process: proc } = this.deps;
    if (this.wasTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }
    proc.off("exit", this.onExit);
    proc.off("uncaughtException", this.onUncaught);
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}
