import { spawn as nodeSpawn } from "node:child_process";
import { CarbonylSubpane } from "./adapters/carbonyl-subpane.js";
import { runDetached } from "./adapters/carbonyl.js";
import { EchoAdapter } from "./adapters/echo-adapter.js";
import { InstagramDmsAdapter } from "./adapters/instagram/dms-adapter.js";
import { InstagramFeedAdapter } from "./adapters/instagram/feed-adapter.js";
import { InstagramReelsAdapter } from "./adapters/instagram/reels-adapter.js";
import { BuiltinAdapterRegistry } from "./adapters/registry.js";
import { JsonRpcClient } from "./adapters/rpc/client.js";
import { ChildProcessTransport } from "./adapters/sidecar/child-transport.js";
import {
  type SubPaneController,
  type SubPaneRect,
  TikTokForYouAdapter,
} from "./adapters/tiktok/foryou-adapter.js";
import { TwitterHomeAdapter } from "./adapters/twitter/home-adapter.js";
import type { AdapterDescriptor, IAdapter, IAdapterRegistry } from "./adapters/types.js";
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
}): IAdapterRegistry {
  const carbonylBin = opts.env.LIMBO_CARBONYL_BIN ?? "carbonyl";

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

  const igReels: AdapterDescriptor = {
    id: "instagram-reels",
    extras: ["instagram"],
    enabled: true,
    keepWarm: false,
    create: (): IAdapter => {
      const transport = new ChildProcessTransport({
        pythonExe: "python3",
        args: ["-m", "limbo_sidecars", "instagram-reels"],
        env: opts.env,
        cwd: opts.cwd,
        spawn: nodeSpawn,
      });
      return new InstagramReelsAdapter({
        client: new JsonRpcClient(transport),
        runDetached: makeRunDetached(),
      });
    },
  };

  const igFeed: AdapterDescriptor = {
    id: "instagram-feed",
    extras: ["instagram"],
    enabled: true,
    keepWarm: false,
    create: (): IAdapter => {
      const transport = new ChildProcessTransport({
        pythonExe: "python3",
        args: ["-m", "limbo_sidecars", "instagram-feed"],
        env: opts.env,
        cwd: opts.cwd,
        spawn: nodeSpawn,
      });
      return new InstagramFeedAdapter({
        client: new JsonRpcClient(transport),
        runDetached: makeRunDetached(),
      });
    },
  };

  const igDms: AdapterDescriptor = {
    id: "instagram-dms",
    extras: ["instagram"],
    enabled: true,
    keepWarm: false,
    create: (): IAdapter => {
      const transport = new ChildProcessTransport({
        pythonExe: "python3",
        args: ["-m", "limbo_sidecars", "instagram-dms"],
        env: opts.env,
        cwd: opts.cwd,
        spawn: nodeSpawn,
      });
      return new InstagramDmsAdapter({ client: new JsonRpcClient(transport) });
    },
  };

  const twitterHome: AdapterDescriptor = {
    id: "twitter-home",
    extras: ["twitter"],
    enabled: true,
    keepWarm: false,
    create: (): IAdapter => {
      const transport = new ChildProcessTransport({
        pythonExe: "python3",
        args: ["-m", "limbo_sidecars", "twitter-home"],
        env: opts.env,
        cwd: opts.cwd,
        spawn: nodeSpawn,
      });
      return new TwitterHomeAdapter({
        client: new JsonRpcClient(transport),
        runDetached: makeRunDetached(),
      });
    },
  };

  const tiktokForYou: AdapterDescriptor = {
    id: "tiktok-foryou",
    extras: ["tiktok"],
    enabled: true,
    keepWarm: false,
    create: (): IAdapter => {
      const transport = new ChildProcessTransport({
        pythonExe: "python3",
        args: ["-m", "limbo_sidecars", "tiktok-foryou"],
        env: opts.env,
        cwd: opts.cwd,
        spawn: nodeSpawn,
      });
      return new TikTokForYouAdapter({
        client: new JsonRpcClient(transport),
        runSubPane: makeRunSubPane(),
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

  return new BuiltinAdapterRegistry([
    igReels,
    igFeed,
    igDms,
    twitterHome,
    tiktokForYou,
    echoDescriptor,
  ]);
}

// @internal — test seam only; not part of the public API
export function _defaultRegistryForTest(env: NodeJS.ProcessEnv, cwd: string): IAdapterRegistry {
  return defaultRegistry({ env, cwd, overlayRef: { current: undefined } });
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
  const cols = opts.stdout.columns ?? DEFAULT_COLS;
  const rows = opts.stdout.rows ?? DEFAULT_ROWS;
  const pty: IPty = opts.ptyFactory({
    file: opts.claudeBin,
    args: opts.argv,
    env: opts.env,
    cwd: opts.cwd,
    cols,
    rows,
  });

  const disposables: IDisposable[] = [];
  const detector: IClaudeDetector = opts.detector ?? new ClaudeStateDetector();
  opts.onDetector?.(detector);

  const overlayRef: OverlayRef = { current: undefined };
  const registry: IAdapterRegistry =
    opts.adapterRegistry ??
    defaultRegistry({
      env: opts.env,
      cwd: opts.cwd,
      overlayRef,
      ptyFactory: opts.ptyFactory,
      stdout: opts.stdout,
    });
  const tabs: readonly TabDefinition[] = opts.tabs ?? defaultTabs(opts.env);

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
