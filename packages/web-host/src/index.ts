import { randomBytes } from 'node:crypto';
import type { WebHostOptions, WebHostHandle } from './types.js';

export type { AppMetadata, BackendBinaryResolver, WebHostOptions, WebHostHandle } from './types.js';
export { startStaticServer, stopStaticServer } from './static-server.js';
export type { StaticServerOptions, StaticServerHandle } from './static-server.js';
export { BackendStartupCancelledError, BackendLifecycleManager, buildSpawnArgs, buildSpawnEnv, findAvailablePort, startBackend, stopBackend } from './backend-launcher.js';
export type { BackendDirConfig, BackendLaunchOptions, BackendHandle, BackendStartOptions } from './backend-launcher.js';

/** Start Core and the public proxy; an optional trusted my-agent bridge shares their lifecycle. */
export async function startWebHost(opts: WebHostOptions): Promise<WebHostHandle> {
  const { startBackend } = await import('./backend-launcher.js');
  const { startStaticServer } = await import('./static-server.js');
  const env = opts.myAgent?.env ?? process.env;
  if (opts.myAgent && opts.backend.kind === 'useExistingBackend' && !env.AIONCORE_BOOTSTRAP_SECRET) {
    throw new Error('CORE_BOOTSTRAP_REQUIRED');
  }
  const bootstrapSecret = opts.myAgent ? env.AIONCORE_BOOTSTRAP_SECRET || randomBytes(32).toString('hex') : '';
  const dataDir = opts.dataDir || opts.app.userDataPath;
  const backendHandle = opts.backend.kind === 'ownBackend' ? await startBackend({
    app: opts.app, resolveBackend: opts.backend.resolveBackend, dataDir, logDir: opts.logDir, dirs: opts.dirs,
    local: opts.backend.local,
    ...(opts.myAgent ? { local: false, extraEnv: { ...env, AIONCORE_BOOTSTRAP_SECRET: bootstrapSecret, AIONUI_MY_AGENT_DATA_DIR: dataDir } } : {}),
  }) : { port: opts.backend.port, stop: async (): Promise<void> => undefined };
  let bridge: Awaited<ReturnType<typeof import('./myagent/service.js').createMyAgentBridge>> | undefined;
  let staticHandle;
  try {
    if (opts.myAgent) {
      const { createMyAgentBridge } = await import('./myagent/service.js');
      bridge = await createMyAgentBridge({ backendPort: backendHandle.port, dataDir, bootstrapSecret, env, runtime: opts.myAgent.runtime });
    }
    staticHandle = await startStaticServer({ staticDir: opts.staticDir, backendPort: backendHandle.port,
      port: opts.port, allowRemote: opts.allowRemote ?? false, requestHandler: bridge?.handleRequest });
  } catch (error) {
    try { await bridge?.close(); } finally { await backendHandle.stop(); }
    throw error;
  }
  return {
    port: staticHandle.port, backendPort: backendHandle.port, url: staticHandle.url, localUrl: staticHandle.localUrl,
    networkUrl: staticHandle.networkUrl, lanIP: staticHandle.lanIP,
    async stop() {
      try { await staticHandle.stop(); } finally {
        try { await backendHandle.stop(); } finally { await bridge?.close(); }
      }
    },
  };
}
