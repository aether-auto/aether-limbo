import { describe, expect, it, vi } from "vitest";
import { BootstrapPanel } from "./bootstrap-panel.js";
import type { IPane } from "./types.js";

function makePane(cols = 80, rows = 24): { pane: IPane; lines: string[][] } {
  const calls: string[][] = [];
  const pane: IPane = {
    cols,
    rows,
    topRow: 0,
    setLines(l) {
      calls.push([...l]);
    },
    writeRaw: () => undefined,
    on: (_event, _listener) => ({ dispose: () => undefined }),
  };
  return { pane, lines: calls };
}

describe("BootstrapPanel", () => {
  it("start() paints header and first message", () => {
    const { pane, lines } = makePane();
    const panel = new BootstrapPanel();
    panel.attach(pane);
    panel.start("Preparing dependencies for Instagram…");

    expect(lines).toHaveLength(1);
    const rendered = lines[0]!;
    expect(rendered[0]).toBe("[ Bootstrapping ]");
    expect(rendered).toContain("Preparing dependencies for Instagram…");
  });

  it("update() appends lines", () => {
    const { pane, lines } = makePane();
    const panel = new BootstrapPanel();
    panel.attach(pane);
    panel.start("init");
    panel.update("creating virtual environment…");
    panel.update("installing instagrapi…");

    const last = lines[lines.length - 1]!;
    expect(last).toContain("creating virtual environment…");
    expect(last).toContain("installing instagrapi…");
  });

  it("update() keeps at most MAX_VISIBLE_LINES (5) content lines", () => {
    const { pane, lines } = makePane();
    const panel = new BootstrapPanel();
    panel.attach(pane);
    panel.start("line-1");
    for (let i = 2; i <= 10; i++) {
      panel.update(`line-${i}`);
    }
    const last = lines[lines.length - 1]!;
    // Should not contain line-1 through line-5 (scrolled out)
    const content = last.filter((l) => l.startsWith("line-"));
    expect(content.length).toBeLessThanOrEqual(5);
    // Should contain the most recent line
    expect(last).toContain("line-10");
  });

  it("error() paints error prefix and error footer", () => {
    const { pane, lines } = makePane();
    const panel = new BootstrapPanel();
    panel.attach(pane);
    panel.start("init");
    panel.error("pip install failed");

    const last = lines[lines.length - 1]!;
    expect(last.some((l) => l.includes("error:") && l.includes("pip install failed"))).toBe(true);
    expect(last.some((l) => l.includes("bootstrap failed"))).toBe(true);
  });

  it("error() footer differs from normal footer", () => {
    const { pane: pane1, lines: progressLines } = makePane();
    const panel1 = new BootstrapPanel();
    panel1.attach(pane1);
    panel1.start("init");
    panel1.update("doing something");

    const { pane: pane2, lines: errorLines } = makePane();
    const panel2 = new BootstrapPanel();
    panel2.attach(pane2);
    panel2.start("init");
    panel2.error("something went wrong");

    const progressFooter = progressLines[progressLines.length - 1]?.at(-1);
    const errorFooter = errorLines[errorLines.length - 1]?.at(-1);
    // Footers should differ
    expect(progressFooter).not.toBe(errorFooter);
  });
});
