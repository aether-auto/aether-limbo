import stripAnsi from "strip-ansi";

export interface Evidence {
  readonly spinnerGlyphs: readonly string[];
  readonly hasSpinnerContext: boolean;
  readonly hasToolMarker: boolean;
  readonly hasPromptSigil: boolean;
  readonly hasStreamingText: boolean;
  readonly visibleText: string;
}

const BRAILLE_GLYPHS = /[⠀-⣿]/g;
const ASCII_SPINNER_GLYPHS = /[✦✧✨✩✪✳✴✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❄❅❆❇❈❉❊❋]/g;

// We use String#includes for the cursor-control fingerprints rather than
// regex literals — `\[` inside a regex literal can pick up an unwanted ESC
// (0x1B) byte during some round-trips through the editor/serializer, which
// silently flipped the test from "matches literal [2K" to "matches ESC[2K".
const TUI_CLEAR_LINE = "[2K";
const TUI_CARRIAGE_RETURN = "\r";

const TOOL_MARKER =
  /(?:\b(?:Running|Calling|Executing|Bash|Read|Write|Edit|Grep|Glob|Task|WebFetch|WebSearch)\b\(|\b(?:Tool use|Tool result|Tool error)\b)/;

const PROMPT_SIGIL = /(?:^|\n)\s*(?:[╭╰][─━]+[╮╯]|[┌└][─━]+[┐┘]|>\s*$|[│┃]\s*>\s*$)/m;

export function analyseChunk(chunk: string): Evidence {
  const visible = stripAnsi(chunk);
  const spinnerGlyphs = [
    ...(visible.match(BRAILLE_GLYPHS) ?? []),
    ...(visible.match(ASCII_SPINNER_GLYPHS) ?? []),
  ];
  const hasClearLine = chunk.includes(TUI_CLEAR_LINE);
  const hasSpinnerContext = chunk.includes(TUI_CARRIAGE_RETURN) || hasClearLine;
  const toolKeywordHit = TOOL_MARKER.test(visible);
  // Plain `\r` is too permissive — `claude --help` ships text with `\r\n`
  // line endings AND literal `Bash(` in flag examples, which would otherwise
  // trip TOOL_MARKER. Require a clear-line escape OR a co-located spinner.
  const toolContext = spinnerGlyphs.length > 0 || hasClearLine;
  return {
    spinnerGlyphs,
    hasSpinnerContext,
    hasToolMarker: toolKeywordHit && toolContext,
    hasPromptSigil: PROMPT_SIGIL.test(visible),
    hasStreamingText: hasMeaningfulText(visible),
    visibleText: visible,
  };
}

function hasMeaningfulText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c < 0x20) continue;
    if (c >= 0x2800 && c <= 0x28ff) continue;
    if (c === 0x20) continue;
    return true;
  }
  return false;
}
