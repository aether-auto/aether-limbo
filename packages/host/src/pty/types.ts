export interface IDisposable {
  dispose(): void;
}

export interface PtyExit {
  readonly exitCode: number;
  readonly signal?: number;
}

export interface IPty {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (event: PtyExit) => void): IDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
}

export type PtyFactory = (opts: PtySpawnOptions) => IPty;
