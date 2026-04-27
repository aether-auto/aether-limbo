import type { ChildProcess } from "node:child_process";
import type { IOverlayController } from "../hotkey/types.js";

export type CarbonylSpawn = (
  file: string,
  args: readonly string[],
  opts: { stdio: "inherit" },
) => ChildProcess;

export interface RunDetachedOptions {
  readonly url: string;
  readonly overlay: IOverlayController;
  readonly spawn: CarbonylSpawn;
  readonly carbonylBin: string;
}

export function runDetached(opts: RunDetachedOptions): Promise<void> {
  opts.overlay.close();
  return new Promise<void>((resolve) => {
    const child = opts.spawn(opts.carbonylBin, [opts.url], { stdio: "inherit" });
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      opts.overlay.open();
      resolve();
    };
    child.on("exit", finish);
    child.on("error", finish);
  });
}
