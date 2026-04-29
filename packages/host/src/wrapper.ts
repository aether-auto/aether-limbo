import { execFile, spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CarbonylSubpane } from "./adapters/carbonyl-subpane.js";
import { runDetached } from "./adapters/carbonyl.js";
import { EchoAdapter } from "./adapters/echo-adapter.js";
import { InstagramDmsAdapter } from "./adapters/instagram/dms-adapter.js";
import { InstagramFeedAdapter } from "./adapters/instagram/feed-adapter.js";
import { InstagramReelsAdapter } from "./adapters/instagram/reels-adapter.js";
import { SharedInstagramSidecar } from "./adapters/instagram/shared-sidecar.js";
import { BuiltinAdapterRegistry } from "./adapters/registry.js";
import { JsonRpcClient } from "./adapters/rpc/client.js";
import { BootstrapRunner } from "./adapters/sidecar/bootstrap-runner.js";
import { ChildProcessTransport } from "./adapters/sidecar/child-transport.js";
import type { RunResult } from "./adapters/sidecar/venv.js";
import {
  type SubPaneController,
  type SubPaneRect,
  TikTokForYouAdapter,
} from "./adapters/tiktok/foryou-adapter.js";
import { TwitterHomeAdapter } from "./adapters/twitter/home-adapter.js";
import type { AdapterDescriptor, IAdapter, IAdapterRegistry } from "./adapters/types.js";
import { getSecretsPath } from "./config/paths.js";
import {
  EMPTY_SECRETS,
  type LimboSecrets,
  mergeSecrets,
  saveSecrets,
  secretsToEnv,
} from "./config/secrets.js";
import { ClaudeStateDetector } from "./detector/detector.js";
import type { IClaudeDetector } from "./detector/types.js";
import { HotkeyInterceptor } from "./hotkey/interceptor.js";
import { ShameFlash } from "./hotkey/shame-flash.js";
import type { HotkeyChord, IHotkeyInterceptor, IOverlayController } from "./hotkey/types.js";
import { LimboOverlay } from "./overlay/overlay.js";
import { DEFAULT_TABS, type TabDefinition } from "./overlay/types.js";
import { translateExit } from "./pty/exit-code.js";
import type { IDisposable, IPty, PtyFactory } from "./pty/types.js";

interface WrapperStdin extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
}

interface WrapperStdout {
  readonly columns?: number;
  readonly rows?: number;
  write(chunk: string): boolean;
}

export interface RunWrapperOptions {
  readonly claudeBin: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdin: WrapperStdin;
  readonly stdout: WrapperStdout;
  readonly process: NodeJS.EventEmitter;
  readonly ptyFactory: PtyFactory;
  readonly detector?: IClaudeDetector;
  readonly onDetector?: (d: IClaudeDetector) => void;
  readonly interceptor?: IHotkeyInterceptor;
  readonly onInterceptor?: (i: IHotkeyInterceptor) => void;
  readonly overlay?: IOverlayController;
  readonly onOverlay?: (o: IOverlayController) => void;
  readonly chord?: HotkeyChord;
  readonly adapterRegistry?: IAdapterRegistry;
  readonly tabs?: readonly TabDefinition[];
  readonly shameMessage?: string;
  readonly shameHoldMs?: number;
  readonly escalation?: { threshold: number; messages: readonly string[] };
  /** Pre-loaded secrets; expand into env vars before sidecar spawn. */
  readonly secrets?: LimboSecrets;
  /**
   * When false the overlay will NOT auto-close when Claude transitions to idle.
   * Defaults to true (auto-close enabled). Wired from config.snapback.enabled.
   */
  readonly snapBackEnabled?: boolean;
  /**
   * Per-adapter env-var overrides derived from config.
   * Keys are adapter ids; values are partial env maps merged into sidecar env.
   */
  readonly adapterEnv?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * Global keepWarm flag from config.adapters.keepWarm.
   * When true every adapter's keepWarm is set to true.
   */
  readonly globalKeepWarm?: boolean;
  /**
   * TikTok-specific keepWarm from config.adapters.tiktok.keepWarm.
   * When true (or globalKeepWarm is true) the TikTok sidecar stays warm.
   */
  readonly tiktokKeepWarm?: boolean;
  /**
   * Directory where the shared venv should be created/maintained.
   * When absent, bootstrap is skipped (assumes venv already exists or test env).
   * Typically: getDataDir(env, home) + "/venv"
   */
  readonly venvDir?: string;
  /**
   * Python executable used to create the venv. Defaults to "python3".
   * Override via LIMBO_PYTHON_EXE env var in cli.ts.
   */
  readonly pythonExe?: string;
  /**
   * Absolute path to the limbo-sidecars Python package (editable install target).
   * Typically resolved relative to this package's installation directory.
   */
  readonly packagePath?: string;
}

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

interface OverlayRef {
  current: IOverlayController | undefined;
}

function defaultRegistry(opts: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  overlayRef: OverlayRef;
  ptyFactory?: PtyFactory;
  stdout?: WrapperStdout;
  onCredentialsConfirmed?: (s: Partial<LimboSecrets>) => void;
  /** Per-adapter env-var overrides from config (keyed by adapter id). */
  adapterEnv?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Global keepWarm override from config.adapters.keepWarm. */
  globalKeepWarm?: boolean;
  /** TikTok-specific keepWarm from config.adapters.tiktok.keepWarm. */
  tiktokKeepWarm?: boolean;
  /**
   * Data directory for the venv bootstrap (e.g. ~/.local/share/aether-limbo).
   * When absent, bootstrap is skipped (venv pre-exists or test environment).
   */
  venvDir?: string;
  /** Python executable for the venv bootstrap; defaults to "python3". */
  pythonExe?: string;
  /** Package path for the sidecar package (editable install target). */
  packagePath?: string;
}): IAdapterRegistry {
  const carbonylBin = opts.env.LIMBO_CARBONYL_BIN ?? "carbonyl";

  /** Merge per-adapter env overrides onto base env for a given adapter id. */
  const adapterEnvFor = (id: string): NodeJS.ProcessEnv => {
    const extra = opts.adapterEnv?.[id];
    if (!extra) return opts.env;
    return { ...opts.env, ...extra };
  };

  const makeRunDetached = (): ((url: string) => Promise<void>) => {
    return (url: string): Promise<void> => {
      const overlay = opts.overlayRef.current;
      if (!overlay) return Promise.resolve();
      return runDetached({ url, overlay, spawn: nodeSpawn, carbonylBin });
    };
  };

  const makeRunSubPane = (): ((url: string, rect: SubPaneRect) => SubPaneController) => {
    return (url: string, rect: SubPaneRect): SubPaneController => {
      const ptyFactory = opts.ptyFactory;
      const stdout = opts.stdout;
      if (!ptyFactory || !stdout) {
        // Test-seam fallback: a no-op controller. Real wrapper always passes both.
        return {
          kill: () => undefined,
          onExit: () => ({ dispose: () => undefined }),
        };
      }
      return new CarbonylSubpane({
        stdout,
        ptyFactory,
        carbonylBin,
        url,
        env: opts.env,
        cwd: opts.cwd,
        top: rect.top,
        left: rect.left,
        cols: rect.cols,
        rows: rect.rows,
      });
    };
  };

  // Helper: only spread onCredentialsConfirmed when it is defined (exactOptionalPropertyTypes).
  const credOpts =
    opts.onCredentialsConfirmed !== undefined
      ? { onCredentialsConfirmed: opts.onCredentialsConfirmed }
      : {};

  // ---------------------------------------------------------------------------
  // Bootstrap runner helpers (shared Filesystem + RunCommand implementations)
  // ---------------------------------------------------------------------------
  const makeBootstrapRunner = (extras: readonly string[]): BootstrapRunner | undefined => {
    if (!opts.venvDir || !opts.packagePath) return undefined;
    const venvDir = opts.venvDir;
    const pythonExe = opts.pythonExe ?? "python3";
    const packagePath = opts.packagePath;

    return new BootstrapRunner({
      venvDir,
      pythonExe,
      pythonVersion: opts.env.LIMBO_PYTHON_VERSION ?? "3.x",
      packagePath,
      fs: {
        exists: async (p: string) => existsSync(p),
        readFile: async (p: string) => readFile(p, "utf8"),
        writeFile: async (p: string, content: string) => {
          await mkdir(path.dirname(p), { recursive: true });
          await writeFile(p, content, "utf8");
        },
      },
      run: async (file: string, args: readonly string[]): Promise<RunResult> => {
        const execFilePromise = promisify(execFile);
        try {
          await execFilePromise(file, [...args], { env: opts.env, cwd: opts.cwd });
          return { code: 0 };
        } catch (err) {
          const e = err as { code?: number; stderr?: string };
          const result: RunResult = { code: e.code ?? 1 };
          if (e.stderr !== undefined) {
            return { ...result, stderr: e.stderr };
          }
          return result;
        }
      },
    });
  };

  // One shared sidecar process for all three Instagram adapters.  The client
  // is lazy-initialised on first access and disposed by the registry's
  // dispose() path (called on wrapper exit).
  const igRunner = makeBootstrapRunner(["instagram"]);
  const igSidecar = new SharedInstagramSidecar({
    env: adapterEnvFor("instagram-reels"), // ig env is shared across all three
    cwd: opts.cwd,
    spawn: nodeSpawn,
    ...(igRunner !== undefined
      ? { bootstrapRunner: igRunner, bootstrapExtras: ["instagram"] }
      : {}),
  });

  // Instagram adapters always keep warm (shared sidecar bundle; cold-start is expensive).
  // Global keepWarm flag does not reduce this — IG is always true.
  const igKeepWarm = true;

  // igSidecar opts for IG adapter construction
  const igSidecarOpts = igSidecar.runner !== undefined ? { igSidecar } : {};

  const igReels: AdapterDescriptor = {
    id: "instagram-reels",
    extras: ["instagram"],
    enabled: true,
    keepWarm: igKeepWarm,
    create: (): IAdapter =>
      new InstagramReelsAdapter({
        client: igSidecar.client,
        runDetached: makeRunDetached(),
        ...credOpts,
        ...igSidecarOpts,
      }),
  };

  const igFeed: AdapterDescriptor = {
    id: "instagram-feed",
    extras: ["instagram"],
    enabled: true,
    keepWarm: igKeepWarm,
    create: (): IAdapter =>
      new InstagramFeedAdapter({
        client: igSidecar.client,
        runDetached: makeRunDetached(),
        ...credOpts,
        ...igSidecarOpts,
      }),
  };

  const igDms: AdapterDescriptor = {
    id: "instagram-dms",
    extras: ["instagram"],
    enabled: true,
    keepWarm: igKeepWarm,
    create: (): IAdapter =>
      new InstagramDmsAdapter({
        client: igSidecar.client,
        ...credOpts,
        ...igSidecarOpts,
      }),
  };

  // Twitter: keepWarm defaults false; global flag can turn it on.
  const twitterKeepWarm = opts.globalKeepWarm === true;
  const twitterRunner = makeBootstrapRunner(["twitter"]);

  const twitterHome: AdapterDescriptor = {
    id: "twitter-home",
    extras: ["twitter"],
    enabled: true,
    keepWarm: twitterKeepWarm,
    create: (): IAdapter => {
      const transport = new ChildProcessTransport({
        pythonExe: opts.pythonExe ?? "python3",
        args: ["-m", "limbo_sidecars", "twitter-home"],
        env: adapterEnvFor("twitter-home"),
        cwd: opts.cwd,
        spawn: nodeSpawn,
      });
      return new TwitterHomeAdapter({
        client: new JsonRpcClient(transport),
        runDetached: makeRunDetached(),
        ...credOpts,
        ...(twitterRunner !== undefined
          ? { bootstrapRunner: twitterRunner, bootstrapExtras: ["twitter"] }
          : {}),
      });
    },
  };

  // TikTok: keepWarm = tiktokKeepWarm || globalKeepWarm (union — either turns it on).
  const tiktokKeepWarm = opts.tiktokKeepWarm === true || opts.globalKeepWarm === true;
  const tiktokRunner = makeBootstrapRunner(["tiktok"]);

  const tiktokForYou: AdapterDescriptor = {
    id: "tiktok-foryou",
    extras: ["tiktok"],
    enabled: true,
    keepWarm: tiktokKeepWarm,
    create: (): IAdapter => {
      const transport = new ChildProcessTransport({
        pythonExe: opts.pythonExe ?? "python3",
        args: ["-m", "limbo_sidecars", "tiktok-foryou"],
        env: adapterEnvFor("tiktok-foryou"),
        cwd: opts.cwd,
        spawn: nodeSpawn,
      });
      return new TikTokForYouAdapter({
        client: new JsonRpcClient(transport),
        runSubPane: makeRunSubPane(),
        ...credOpts,
        ...(tiktokRunner !== undefined
          ? { bootstrapRunner: tiktokRunner, bootstrapExtras: ["tiktok"] }
          : {}),
      });
    },
  };

  const echoDescriptor: AdapterDescriptor = {
    id: "echo",
    extras: [],
    enabled: true,
    keepWarm: false,
    create: (): IAdapter => {
      const transport = new ChildProcessTransport({
        pythonExe: "python3",
        args: ["-m", "limbo_sidecars", "echo"],
        env: opts.env,
        cwd: opts.cwd,
        spawn: nodeSpawn,
      });
      return new EchoAdapter({ client: new JsonRpcClient(transport) });
    },
  };

  const inner = new BuiltinAdapterRegistry([
    igReels,
    igFeed,
    igDms,
    twitterHome,
    tiktokForYou,
    echoDescriptor,
  ]);

  // Wrap dispose() so the shared Instagram sidecar process is also torn down
  // when the registry shuts down (wrapper exit).
  return {
    get: (id: string) => inner.get(id),
    list: () => inner.list(),
    release: (adapter: IAdapter) => inner.release(adapter),
    dispose: async (): Promise<void> => {
      await inner.dispose();
      igSidecar.dispose();
    },
  };
}

// @internal — test seam only; not part of the public API
export function _defaultRegistryForTest(
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts?: {
    globalKeepWarm?: boolean;
    tiktokKeepWarm?: boolean;
    adapterEnv?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  },
): IAdapterRegistry {
  return defaultRegistry({
    env,
    cwd,
    overlayRef: { current: undefined },
    ...(opts?.globalKeepWarm !== undefined ? { globalKeepWarm: opts.globalKeepWarm } : {}),
    ...(opts?.tiktokKeepWarm !== undefined ? { tiktokKeepWarm: opts.tiktokKeepWarm } : {}),
    ...(opts?.adapterEnv !== undefined ? { adapterEnv: opts.adapterEnv } : {}),
  });
}

function defaultTabs(env: NodeJS.ProcessEnv): readonly TabDefinition[] {
  if (env.LIMBO_DEBUG_ECHO === "1") {
    return [
      ...DEFAULT_TABS,
      { id: "__echo", label: "Echo", placeholderRef: "§4.6 demo", adapterId: "echo" },
    ];
  }
  return DEFAULT_TABS;
}

export function runWrapper(opts: RunWrapperOptions): Promise<number> {
  // Merge secrets into env: secrets fill gaps, explicit process env trumps.
  const secrets = opts.secrets ?? EMPTY_SECRETS;
  const mergedEnv: NodeJS.ProcessEnv = { ...secretsToEnv(secrets), ...opts.env };

  const cols = opts.stdout.columns ?? DEFAULT_COLS;
  const rows = opts.stdout.rows ?? DEFAULT_ROWS;
  const pty: IPty = opts.ptyFactory({
    file: opts.claudeBin,
    args: opts.argv,
    env: mergedEnv,
    cwd: opts.cwd,
    cols,
    rows,
  });

  const disposables: IDisposable[] = [];
  const detector: IClaudeDetector = opts.detector ?? new ClaudeStateDetector();
  opts.onDetector?.(detector);

  // Mutable secrets reference: updated in place when credentials are confirmed.
  let currentSecrets: LimboSecrets = secrets;

  // Compute secrets path once using process HOME (falls back to os.homedir()).
  const secretsPath = getSecretsPath(opts.env, opts.env.HOME ?? homedir());

  const onCredentialsConfirmed = (patch: Partial<LimboSecrets>): void => {
    currentSecrets = mergeSecrets(currentSecrets, patch);
    // Best-effort save: log to stderr on failure so the user knows credentials weren't persisted.
    saveSecrets({ path: secretsPath, secrets: currentSecrets }).catch((err) =>
      process.stderr.write(
        "limbo: failed to save secrets: " +
          (err instanceof Error ? err.message : String(err)) +
          "\n",
      ),
    );
  };

  const overlayRef: OverlayRef = { current: undefined };
  const registry: IAdapterRegistry =
    opts.adapterRegistry ??
    defaultRegistry({
      env: mergedEnv,
      cwd: opts.cwd,
      overlayRef,
      ptyFactory: opts.ptyFactory,
      stdout: opts.stdout,
      onCredentialsConfirmed: onCredentialsConfirmed,
      ...(opts.adapterEnv !== undefined ? { adapterEnv: opts.adapterEnv } : {}),
      ...(opts.globalKeepWarm !== undefined ? { globalKeepWarm: opts.globalKeepWarm } : {}),
      ...(opts.tiktokKeepWarm !== undefined ? { tiktokKeepWarm: opts.tiktokKeepWarm } : {}),
      ...(opts.venvDir !== undefined ? { venvDir: opts.venvDir } : {}),
      ...(opts.pythonExe !== undefined ? { pythonExe: opts.pythonExe } : {}),
      ...(opts.packagePath !== undefined ? { packagePath: opts.packagePath } : {}),
    });
  const tabs: readonly TabDefinition[] = opts.tabs ?? defaultTabs(opts.env);

  // snapBackEnabled defaults to true when unset.
  const snapBackEnabled = opts.snapBackEnabled !== false;

  const overlay: IOverlayController =
    opts.overlay ??
    new LimboOverlay({
      stdout: opts.stdout,
      detector,
      registry,
      tabs,
      onSnapBack: () =>
        pty.resize(opts.stdout.columns ?? DEFAULT_COLS, opts.stdout.rows ?? DEFAULT_ROWS),
      ...(opts.chord !== undefined ? { chord: opts.chord } : {}),
      snapBackEnabled,
    });
  opts.onOverlay?.(overlay);
  overlayRef.current = overlay;

  const interceptor: IHotkeyInterceptor =
    opts.interceptor ??
    new HotkeyInterceptor({
      detector,
      overlay,
      shame: new ShameFlash({
        stdout: opts.stdout,
        ...(opts.shameMessage !== undefined ? { message: opts.shameMessage } : {}),
        ...(opts.shameHoldMs !== undefined ? { holdMs: opts.shameHoldMs } : {}),
      }),
      ...(opts.chord !== undefined ? { chord: opts.chord } : {}),
      ...(opts.escalation !== undefined ? { escalation: opts.escalation } : {}),
    });
  opts.onInterceptor?.(interceptor);

  const onStdinData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("binary");
    const passthrough = interceptor.feed(text);
    if (passthrough.length === 0) return;
    if (overlay.isOpen()) {
      overlay.handleInput(passthrough);
    } else {
      pty.write(passthrough);
    }
  };
  opts.stdin.on("data", onStdinData);

  const onWinch = (): void => {
    const c = opts.stdout.columns ?? DEFAULT_COLS;
    const r = opts.stdout.rows ?? DEFAULT_ROWS;
    pty.resize(c, r);
    if (overlay.isOpen()) overlay.handleResize(c, r);
  };
  opts.process.on("SIGWINCH", onWinch);

  const signalHandlers = new Map<ForwardedSignal, () => void>();
  for (const sig of FORWARDED_SIGNALS) {
    const handler = (): void => pty.kill(sig);
    signalHandlers.set(sig, handler);
    opts.process.on(sig, handler);
  }

  disposables.push(
    pty.onData((data) => {
      opts.stdout.write(data);
      try {
        detector.feed(data);
      } catch {
        // Detector failures must never affect pass-through. Swallow and continue.
      }
    }),
  );

  return new Promise<number>((resolve) => {
    disposables.push(
      pty.onExit((event) => {
        opts.stdin.off("data", onStdinData);
        opts.process.off("SIGWINCH", onWinch);
        for (const [sig, handler] of signalHandlers) {
          opts.process.off(sig, handler);
        }
        for (const d of disposables) d.dispose();
        if (overlay.isOpen()) overlay.close();
        detector.dispose();
        void registry.dispose?.().then(() => resolve(translateExit(event)));
      }),
    );
  });
}
