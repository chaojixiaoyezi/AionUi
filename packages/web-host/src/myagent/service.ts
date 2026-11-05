import type { IncomingMessage, ServerResponse } from 'node:http';
import { openBridgeStore, type StoreEntry } from './store.js';
import { loadMyAgentConfig } from './config.js';
import { verifyPasswordRecord } from './auth.js';
import { readPrivateText } from './io.js';
import { GatewayClient, type JsonObject } from './gateway.js';
import { coreClient, dataOf, readJsonBody, relayJson, sameOrigin, sendJson, sessionHeaders, succeeded } from './http.js';
import { createCatalogBootstrap, MY_AGENT_ID, MY_AGENT_NAME, objectOf, type AdapterRuntime } from './bootstrap.js';

export type BridgeOptions = { backendPort: number; dataDir: string; bootstrapSecret: string; env: NodeJS.ProcessEnv; runtime: AdapterRuntime };

/** Trusted WebUI middleware: Core owns identities/cookies; Gateway owns execution. */
export async function createMyAgentBridge(options: BridgeOptions) {
  const config = loadMyAgentConfig(options.env);
  const store = await openBridgeStore(options.dataDir, options.env);
  const core = coreClient(options.backendPort);
  const gateway = new GatewayClient(config);
  const ensureCatalog = createCatalogBootstrap(core, store, options.runtime);
  const attempts = new Map<string, { count: number; since: number }>();
  let verifying = 0;
  let closed = false;

  const login = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!sameOrigin(req)) { sendJson(res, 403, { success: false, error: 'CROSS_SITE_REQUEST' }); return; }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      sendJson(res, 415, { success: false, error: 'JSON_REQUIRED' }); return;
    }
    const now = Date.now();
    const key = req.socket.remoteAddress || 'local';
    if (attempts.size > 1000) for (const [ip, row] of attempts) if (now - row.since > 60000) attempts.delete(ip);
    const row = attempts.get(key);
    const next = !row || now - row.since > 60000 ? { count: 1, since: now } : { ...row, count: row.count + 1 };
    attempts.set(key, next);
    if (next.count > 30 || verifying >= 4) { sendJson(res, 429, { success: false, error: 'LOGIN_RATE_LIMITED' }); return; }
    verifying++;
    try {
      const body = await readJsonBody(req, 16384);
      if (typeof body?.username !== 'string' || typeof body.password !== 'string' || body.password.length > 4096) {
        sendJson(res, 400, { success: false, error: 'INVALID_LOGIN' }); return;
      }
      // Preserve existing native users and passwords. No password-table mutation.
      const native = await core('/login', 'POST', body);
      if (succeeded(native)) { relayJson(res, native); return; }
      if (native.status !== 401 || body.username !== config.adminUsername || !config.adminPasswordFile) {
        relayJson(res, native); return;
      }
      const record: unknown = JSON.parse(await readPrivateText(config.adminPasswordFile));
      if (!await verifyPasswordRecord(body.password, record)) { relayJson(res, native); return; }
      if (!options.bootstrapSecret) throw new Error('CORE_BOOTSTRAP_REQUIRED');
      const externalId = `my-agent:${config.adminUsername}`;
      const headers = { 'x-aioncore-bootstrap-secret': options.bootstrapSecret };
      const ensured = await core(`/api/auth/internal/external-users/${encodeURIComponent(externalId)}`, 'PUT', {
        user_type: 'aionpro', username: `my-agent-${config.adminUsername}`,
      }, headers);
      if (!succeeded(ensured)) throw new Error('CORE_IDENTITY_EXCHANGE_FAILED');
      const session = await core('/api/auth/internal/external-sessions', 'POST', { user_type: 'aionpro', external_user_id: externalId }, headers);
      const data = objectOf(dataOf(session));
      const user = objectOf(data.user);
      if (!succeeded(session) || typeof user.id !== 'string' || !session.headers['set-cookie']?.length) throw new Error('CORE_IDENTITY_EXCHANGE_FAILED');
      await store.write([{ table: 'user_settings', key: `${user.id}:my-agent-admin`, value: { username: config.adminUsername } }]);
      sendJson(res, 200, { success: true, user }, session.headers['set-cookie']);
    } finally { verifying--; }
  };

  const mirror = async (userId: string, path: string, method: string, data: unknown): Promise<void> => {
    const entries: StoreEntry[] = [{ table: 'sync_metadata', key: `${userId}:${path}`, value: { path, method, synced_at: Date.now() } }];
    const object = objectOf(data);
    const messages = /^\/api\/conversations\/([^/]+)\/messages$/.exec(path);
    const conversation = /^\/api\/conversations\/([^/]+)$/.exec(path);
    if (messages && Array.isArray(data)) {
      for (const message of data) {
        const item = objectOf(message);
        if (typeof item.id === 'string') entries.push({ table: 'messages', key: `${userId}:${decodeURIComponent(messages[1])}:${item.id}`, value: item });
      }
    } else if (path === '/api/conversations' || conversation) {
      const values = Array.isArray(data) ? data : [data];
      for (const value of values) {
        const item = objectOf(value);
        if (typeof item.id === 'string') entries.push({ table: 'conversations', key: `${userId}:${item.id}`, value: item });
      }
      if (method === 'DELETE' && conversation) {
        const key = `${userId}:${decodeURIComponent(conversation[1])}`;
        await store.remove('conversations', key);
        for (const message of await store.list('messages', `${key}:`)) await store.remove('messages', message.key);
      }
    } else if (path === '/api/settings/client') entries.push({ table: 'user_settings', key: `${userId}:client`, value: object });
    await store.write(entries);
  };

  return {
    store,
    async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      let path: string;
      try { path = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname); }
      catch { sendJson(res, 400, { success: false, error: 'INVALID_PATH' }); return true; }
      // These loopback-only Core endpoints must never be exposed by the public proxy.
      if (path.startsWith('/api/auth/internal/') || req.headers['x-aioncore-bootstrap-secret']) {
        sendJson(res, 404, { success: false, error: 'NOT_FOUND' }); return true;
      }
      const method = req.method || 'GET';
      const tracked = path === '/api/assistants' || path === '/api/agents/management' || path === '/api/providers' ||
        path === '/api/settings/client' || /^\/api\/conversations(?:\/[^/]+(?:\/messages)?)?$/.test(path);
      if (!(path === '/login' && method === 'POST') && !tracked) return false;
      if (closed) { sendJson(res, 503, { success: false, error: 'BRIDGE_CLOSED' }); return true; }
      let committed = false;
      try {
        if (path === '/login') { await login(req, res); return true; }
        if (!['GET', 'HEAD'].includes(method) && !sameOrigin(req)) {
          sendJson(res, 403, { success: false, error: 'CROSS_SITE_REQUEST' }); return true;
        }
        const headers = sessionHeaders(req);
        const identity = await core('/api/auth/user', 'GET', undefined, headers);
        const user = objectOf(identity.payload.user ?? objectOf(dataOf(identity)).user);
        if (!succeeded(identity) || typeof user.id !== 'string') {
          sendJson(res, 401, { success: false, error: 'AUTH_REQUIRED' }); return true;
        }
        const userId = user.id;
        const admin = user.username === config.adminUsername || !!await store.get('user_settings', `${userId}:my-agent-admin`);
        const body = ['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : await readJsonBody(req);
        const useAdapter = objectOf(body?.assistant).id === MY_AGENT_ID || body?.assistant_id === MY_AGENT_ID;
        if (admin && ((method === 'GET' && ['/api/assistants', '/api/agents/management', '/api/providers', '/api/settings/client'].includes(path)) || useAdapter)) {
          await ensureCatalog(userId, headers);
        } else if (useAdapter) { sendJson(res, 403, { success: false, error: 'ADMIN_REQUIRED' }); return true; }
        const response = await core(req.url || path, method, body, headers);
        committed = !['GET', 'HEAD'].includes(method) && succeeded(response);
        if (succeeded(response)) {
          let data = dataOf(response);
          if (path === '/api/providers' && method === 'GET' && admin) {
            const catalog = await gateway.models(`aionui:${userId}:catalog`);
            if (!Array.isArray(catalog.profiles)) throw new Error('INVALID_GATEWAY_MODELS');
            const profiles = (catalog.profiles as JsonObject[]).filter((p) => typeof p.id === 'string' && p.enabled !== false)
              .map((p) => ({ id: p.id, model_name: String(p.model_name || p.name || p.id) }));
            const provider = { id: MY_AGENT_ID, name: MY_AGENT_NAME, platform: 'custom', base_url: '', api_key: '', models: profiles.map((p) => p.model_name), readonly: true, profiles };
            data = [provider, ...(Array.isArray(data) ? data : [])];
            response.payload = { ...response.payload, data };
            await store.write([{ table: 'sync_metadata', key: `${userId}:models`, value: { profiles, synced_at: Date.now() } }]);
          }
          if (path === '/api/assistants' && method === 'GET' && admin && Array.isArray(data)) {
            data = [...data].sort((a, b) => Number(objectOf(b).id === MY_AGENT_ID) - Number(objectOf(a).id === MY_AGENT_ID));
            response.payload = { ...response.payload, data };
          }
          if (path === '/api/settings/client' && method === 'PUT') {
            const canonical = await core('/api/settings/client', 'GET', undefined, headers);
            if (!succeeded(canonical)) throw new Error('CORE_SETTINGS_SYNC_FAILED');
            data = dataOf(canonical);
          }
          await mirror(userId, path, method, data);
        }
        relayJson(res, response);
      } catch (error) {
        const code = error instanceof Error && ['INVALID_JSON_BODY', 'INVALID_PATH'].includes(error.message) ? error.message :
          error instanceof SyntaxError ? 'INVALID_JSON_BODY' : error instanceof Error && error.message === 'REQUEST_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'MY_AGENT_BRIDGE_UNAVAILABLE';
        sendJson(res, code === 'REQUEST_TOO_LARGE' ? 413 : code === 'INVALID_JSON_BODY' || code === 'INVALID_PATH' ? 400 : 502,
          { success: false, error: code, ...(committed ? { upstream_committed: true, retry_safe: false } : {}) });
      }
      return true;
    },
    async close(): Promise<void> { closed = true; await store.close(); },
  };
}
