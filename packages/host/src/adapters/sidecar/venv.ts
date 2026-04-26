import { createHash } from "node:crypto";
import path from "node:path";

export interface Filesystem {
  exists(p: string): Promise<boolean>;
  readFile(p: string): Promise<string>;
  writeFile(p: string, content: string): Promise<void>;
}

export interface RunResult {
  readonly code: number;
  readonly stderr?: string;
}

export type RunCommand = (file: string, args: readonly string[]) => Promise<RunResult>;

export type BootstrapPhase = "creating-venv" | "installing-package" | "writing-manifest" | "done";

export interface BootstrapProgress {
  readonly phase: BootstrapPhase;
  readonly extras: readonly string[];
}

export interface VenvBootstrapOptions {
  readonly venvDir: string;
  readonly pythonExe: string;
  readonly pythonVersion: string;
  readonly packagePath: string;
  readonly fs: Filesystem;
  readonly run: RunCommand;
  readonly onProgress: (p: BootstrapProgress) => void;
}

interface Manifest {
  readonly pythonVersion: string;
  readonly extras: readonly string[];
  readonly hash: string;
}

export function computeManifestHash(args: {
  pythonVersion: string;
  extras: readonly string[];
}): string {
  const sorted = [...args.extras].sort();
  return createHash("sha256")
    .update(args.pythonVersion)
    .update("|")
    .update(sorted.join(","))
    .digest("hex");
}

const MANIFEST_NAME = ".limbo-manifest.json";

/**
 * Lazy venv bootstrap for Python sidecars. Uses the Unix venv layout
 * (`<venvDir>/bin/python` and `bin/pip`); Windows is out of scope per
 * PLAN.md §5.
 */
export class VenvBootstrap {
  constructor(private readonly opts: VenvBootstrapOptions) {}

  async ensure(extras: readonly string[]): Promise<void> {
    const dedup = Array.from(new Set(extras)).sort();
    const expected = computeManifestHash({
      pythonVersion: this.opts.pythonVersion,
      extras: dedup,
    });
    const venvPython = path.join(this.opts.venvDir, "bin", "python");
    const manifestPath = path.join(this.opts.venvDir, MANIFEST_NAME);

    const venvExists = await this.opts.fs.exists(venvPython);
    if (venvExists) {
      const cur = await this.readManifest(manifestPath);
      if (cur && cur.hash === expected) {
        this.opts.onProgress({ phase: "done", extras: dedup });
        return;
      }
    }

    if (!venvExists) {
      this.opts.onProgress({ phase: "creating-venv", extras: dedup });
      const r = await this.opts.run(this.opts.pythonExe, ["-m", "venv", this.opts.venvDir]);
      if (r.code !== 0) throw new Error(`venv create failed: ${r.stderr ?? ""}`);
    }

    this.opts.onProgress({ phase: "installing-package", extras: dedup });
    const pip = path.join(this.opts.venvDir, "bin", "pip");
    const target =
      dedup.length > 0 ? `${this.opts.packagePath}[${dedup.join(",")}]` : this.opts.packagePath;
    const install = await this.opts.run(pip, ["install", "--quiet", "-e", target]);
    if (install.code !== 0) throw new Error(`pip install failed: ${install.stderr ?? ""}`);

    this.opts.onProgress({ phase: "writing-manifest", extras: dedup });
    const manifest: Manifest = {
      pythonVersion: this.opts.pythonVersion,
      extras: dedup,
      hash: expected,
    };
    await this.opts.fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    this.opts.onProgress({ phase: "done", extras: dedup });
  }

  private async readManifest(p: string): Promise<Manifest | undefined> {
    if (!(await this.opts.fs.exists(p))) return undefined;
    try {
      return JSON.parse(await this.opts.fs.readFile(p)) as Manifest;
    } catch {
      return undefined;
    }
  }
}
