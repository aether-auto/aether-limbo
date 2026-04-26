# scripts

## record-pty-fixture.mjs

Captures a real PTY session into `test/fixtures/detector/<basename>.{bin,json}`,
in the format consumed by `test/detector-replay.test.ts`.

```sh
node packages/host/scripts/record-pty-fixture.mjs <basename> [--max-ms N] -- <cmd> [args...]
```

Example — record `claude --help` (deterministic, fast, real ANSI):

```sh
node packages/host/scripts/record-pty-fixture.mjs scenario-2 --max-ms 3000 -- claude --help
```

The recorder writes both files unannotated. Open the `.json` in your editor and
add `expectAfter` values to interesting chunks so the replay test will assert
the classification you expect. Keep `.bin` and `.json` in sync (the replay test
verifies byte equivalence between the two).

For the long-running interactive scenario referenced in `PLAN.md` §4.13, run
the recorder against an interactive `claude` session, then trim and annotate
the resulting fixture by hand.
