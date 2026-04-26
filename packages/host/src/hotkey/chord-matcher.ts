import type { ChordFeedResult, HotkeyChord } from "./types.js";

export class ChordMatcher {
  private pending = "";

  constructor(private readonly chord: HotkeyChord) {
    if (chord.length === 0) {
      throw new Error("ChordMatcher: chord must be non-empty");
    }
  }

  feed(chunk: string): ChordFeedResult {
    if (chunk.length === 0) {
      return { passthrough: "", matched: 0 };
    }

    const buffer = this.pending + chunk;
    let passthrough = "";
    let matched = 0;
    let i = 0;

    while (i < buffer.length) {
      const remaining = buffer.length - i;

      if (remaining >= this.chord.length) {
        if (buffer.startsWith(this.chord, i)) {
          matched++;
          i += this.chord.length;
          continue;
        }
        passthrough += buffer[i];
        i++;
        continue;
      }

      const tail = buffer.slice(i);
      if (this.chord.startsWith(tail)) {
        this.pending = tail;
        return { passthrough, matched };
      }

      passthrough += buffer[i];
      i++;
    }

    this.pending = "";
    return { passthrough, matched };
  }

  flush(): string {
    const held = this.pending;
    this.pending = "";
    return held;
  }

  reset(): void {
    this.pending = "";
  }
}
