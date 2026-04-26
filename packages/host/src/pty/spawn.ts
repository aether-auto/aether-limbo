import { spawn as ptySpawn } from "node-pty";
import type { IPty, PtyFactory, PtySpawnOptions } from "./types.js";

export const defaultPtyFactory: PtyFactory = (opts: PtySpawnOptions): IPty => {
  return ptySpawn(opts.file, [...opts.args], {
    name: "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
  });
};
