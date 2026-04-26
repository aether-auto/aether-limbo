import stripAnsi from "strip-ansi";
import type { TabDefinition } from "./types.js";

const SGR_RESET = "\x1b[0m";
const SGR_INVERT = "\x1b[7m";
const TAB_GAP = "  ";

export interface RenderTabBarArgs {
  readonly tabs: readonly TabDefinition[];
  readonly activeIndex: number;
  readonly cols: number;
}

export function renderTabBar(args: RenderTabBarArgs): string {
  const parts: string[] = [];
  for (let i = 0; i < args.tabs.length; i++) {
    const tab = args.tabs[i];
    if (tab === undefined) continue;
    const label = ` ${tab.label} `;
    parts.push(i === args.activeIndex ? `${SGR_INVERT}${label}${SGR_RESET}` : label);
  }
  const joined = parts.join(TAB_GAP);
  const padding = Math.max(0, args.cols - stripAnsi(joined).length);
  return `${joined}${" ".repeat(padding)}`;
}
