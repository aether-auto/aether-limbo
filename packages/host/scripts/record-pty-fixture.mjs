#!/usr/bin/env node
// Record a real PTY session into a (.bin, .json) pair under
// `test/fixtures/detector/`, in the format consumed by detector-replay.test.ts.
//
//   node scripts/record-pty-fixture.mjs <basename> [--max-ms N] -- <cmd> [args...]
//
// Example:
//   node scripts/record-pty-fixture.mjs scenario-2 --max-ms 3000 -- claude --help
//
// The recorder appends a "settle window" on the end so the detector has a
// chance to drift back to idle in the replayed timeline. `expectAfter` is
// intentionally NOT inferred — annotate by hand once you've reviewed the
// captured ANSI in `.bin`.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { spawn as ptySpawn } from "node-pty";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(HERE, "..", "test", "fixtures", "detector");
const SETTLE_AFTER_MS = 1000;

function usage(msg) {
  if (msg) stderr.write(`error: ${msg}\n`);
  stderr.write("usage: record-pty-fixture <basename> [--max-ms N] -- <cmd> [args...]\n");
  exit(2);
}

function parseArgs(rawArgv) {
  const args = rawArgv.slice(2);
  const dashDash = args.indexOf("--");
  if (dashDash === -1) usage("missing `--` separator before the command");
  const head = args.slice(0, dashDash);
  const tail = args.slice(dashDash + 1);
  if (head.length === 0) usage("missing <basename>");
  if (tail.length === 0) usage("missing <cmd> after `--`");
  const basename = head[0];
  let maxMs = 5000;
  for (let i = 1; i < head.length; i++) {
    if (head[i] === "--max-ms") {
      const v = Number(head[++i]);
      if (!Number.isFinite(v) || v <= 0) usage("--max-ms must be a positive number");
      maxMs = v;
    } else {
      usage(`unknown flag: ${head[i]}`);
    }
  }
  return { basename, maxMs, cmd: tail[0], cmdArgs: tail.slice(1) };
}

const { basename, maxMs, cmd, cmdArgs } = parseArgs(argv);

mkdirSync(FIXTURES_DIR, { recursive: true });
const binPath = resolve(FIXTURES_DIR, `${basename}.bin`);
const jsonPath = resolve(FIXTURES_DIR, `${basename}.json`);

const child = ptySpawn(cmd, cmdArgs, {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});

const start = Date.now();
const chunks = [];
const buffers = [];

child.onData((data) => {
  const atMs = Date.now() - start;
  buffers.push(Buffer.from(data, "utf8"));
  chunks.push({ atMs, text: data });
});

const killTimer = setTimeout(() => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
}, maxMs);

child.onExit((event) => {
  clearTimeout(killTimer);
  const fixture = {
    name: `${basename} (recorded ${cmd} ${cmdArgs.join(" ")})`,
    description: `Captured ${chunks.length} chunks, ${buffers.reduce((n, b) => n + b.length, 0)} bytes. Annotate \`expectAfter\` per chunk after review.`,
    debounceMs: 150,
    initialState: "idle",
    chunks,
    settleAfterMs: SETTLE_AFTER_MS,
    finalState: "idle",
    recordedAt: new Date().toISOString(),
    childExitCode: event.exitCode,
    childSignal: event.signal ?? null,
  };
  writeFileSync(binPath, Buffer.concat(buffers));
  writeFileSync(jsonPath, `${JSON.stringify(fixture, null, 2)}\n`);
  stdout.write(`wrote ${binPath} (${buffers.reduce((n, b) => n + b.length, 0)} bytes)\n`);
  stdout.write(`wrote ${jsonPath} (${chunks.length} chunks)\n`);
  exit(0);
});
