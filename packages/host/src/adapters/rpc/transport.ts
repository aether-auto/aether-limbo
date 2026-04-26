import type { IDisposable } from "../../pty/types.js";

export interface TransportExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface ITransport {
  write(chunk: string): void;
  onData(listener: (chunk: string) => void): IDisposable;
  onExit(listener: (exit: TransportExit) => void): IDisposable;
  close(): void;
}
