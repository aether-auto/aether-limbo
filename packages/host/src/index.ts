export { ClaudeNotFoundError, resolveClaudeBin } from "./resolve-claude.js";
export { translateExit } from "./pty/exit-code.js";
export { TerminalGuard } from "./terminal/terminal-guard.js";
export { runWrapper } from "./wrapper.js";
export type { IPty, PtyExit, PtyFactory, PtySpawnOptions } from "./pty/types.js";
export const VERSION = "0.0.0";
