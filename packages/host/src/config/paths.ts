/**
 * Pure path-resolution functions for aether-limbo config/data directories.
 * No I/O — all functions accept env and home as parameters for testability.
 */

export function getConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const base = env.XDG_CONFIG_HOME ?? `${home}/.config`;
  return `${base}/aether-limbo`;
}

export function getConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return `${getConfigDir(env, home)}/config.toml`;
}

export function getSecretsPath(env: NodeJS.ProcessEnv, home: string): string {
  return `${getConfigDir(env, home)}/secrets.toml`;
}

export function getDataDir(env: NodeJS.ProcessEnv, home: string): string {
  const base = env.XDG_DATA_HOME ?? `${home}/.local/share`;
  return `${base}/aether-limbo`;
}
