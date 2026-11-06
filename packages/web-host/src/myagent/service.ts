import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openBridgeStore, type BridgeStore, type StoreEntry } from './store.js';
import { loadMyAgentConfig } from './config.js';
import { verifyPasswordRecord } from './auth.js';
import { readPrivateText, type JsonResponse } from './io.js';
import { GatewayClient, type GatewayIdentity, type JsonObject } from './gateway.js';
import { coreClient, dataOf, readJsonBody, relayJson, sameOrigin, sendJson, sessionHeaders, succeeded } from './http.js';
import { createCatalogBootstrap, MY_AGENT_ID, MY_AGENT_NAME, objectOf, type AdapterRuntime } from './bootstrap.js';
import { handleMyAgentRoutes } from './routes.js';
import { gatewayIdentityFor, handleExternalConversation, handleSessionProgress, isExternalConversationPath, isGatewayBridgePath, mergeGatewaySessions, type Caller } from './sessions.js';

export type BridgeOptions = { backendPort: number; dataDir: string; bootstrapSecret: string; env: NodeJS.ProcessEnv; runtime: AdapterRuntime };

/** Read persisted bridge snapshots using the same user-scoped keys as the HTTP mirror. */
export class MyAgentWebService {
  constructor(private readonly store: Pick<BridgeStore, 'get' | 'list'>) {}

  /** Return only this user's conversation messages; missing and foreign IDs are indistinguishable. */
  async getConversationMessages(userId: string, id: string): Promise<unknown[]> {
    const key = `${userId}:${id}`;
    if (!userId || !id || objectOf(await this.store.get('conversations', key)).id !== id) {
      throw new Error('NOT_FOUND');
    }
    return (await this.store.list('messages', `${key}:`)).map((entry) => entry.value);
  }
}

/** Trusted WebUI middleware: Core owns identities/cookies; Gateway owns execution. */
export async function createMyAgentBridge(options: BridgeOptions) {
  const config = loadMyAgentConfig(options.env);
  const store = await openBridgeStore(options.dataDir, options.env);
  const service = new MyAgentWebService(store);
  const core = coreClient(options.backendPort);
  const gateway = new GatewayClient(config);
  const ensureCatalog = createCatalogBootstrap(core, store, options.runtime);
  const attempts = new Map<string, { count: number; since: number }>();
  const identityCache = new Map<string, { response: JsonResponse; expiresAt: number }>();
  const inflightIdentity = new Map<string, Promise<JsonResponse>>();
  const modelsCache = new Map<string, { profiles: { id: string; model_name: string }[]; expiresAt: number }>();
  const inflightModels = new Map<string, Promise<{ id: string; model_name: string }[]>>();
  let verifying = 0;
  let closed = false;

  const resolveModels = (userId: string): Promise<{ id: string; model_name: string }[]> => {
    const now = Date.now();
    const cached = modelsCache.get(userId);
    if (cached && cached.expiresAt > now) return Promise.resolve(cached.profiles);
    const pending = inflightModels.get(userId);
    if (pending) return pending;
    const lookup = gateway.models(`aionui:${userId}:catalog`).then(async (catalog) => {
      inflightModels.delete(userId);
      if (!Array.isArray(catalog.profiles)) throw new Error('INVALID_GATEWAY_MODELS');
      const profiles = (catalog.profiles as JsonObject[]).filter((p) => typeof p.id === 'string' && p.enabled !== false)
        .map((p) => ({ id: String(p.id), model_name: String(p.model_name || p.name || p.id) }));
      modelsCache.set(userId, { profiles, expiresAt: Date.now() + 30_000 });
      await store.write([{ table: 'sync_metadata', key: `${userId}:models`, value: { profiles, synced_at: Date.now() } }]);
      return profiles;
    }).catch((err) => {
      inflightModels.delete(userId);
      throw err;
    });
    inflightModels.set(userId, lookup);
    return lookup;
  };

  const sessionKeyOf = (headers: Record<string, string>): string => {
    const raw = `${headers.cookie || ''}|${headers.authorization || ''}`.trim();
    return raw ? createHash('sha256').update(raw).digest('hex') : '';
  };

  const resolveIdentity = async (headers: Record<string, string>): Promise<JsonResponse> => {
    const key = sessionKeyOf(headers);
    const now = Date.now();
    if (key) {
      const cached = identityCache.get(key);
      if (cached && cached.expiresAt > now) return cached.response;
      const pending = inflightIdentity.get(key);
      if (pending) return pending;
    }
    const lookup = core('/api/auth/user', 'GET', undefined, headers).then((res) => {
      if (key) {
        inflightIdentity.delete(key);
        const user = objectOf(res.payload.user ?? objectOf(dataOf(res)).user);
        if (succeeded(res) && typeof user.id === 'string') {
          if (identityCache.size >= 512) {
            for (const [k, v] of identityCache) if (v.expiresAt <= now) identityCache.delete(k);
            if (identityCache.size >= 512) {
              const oldest = identityCache.keys().next().value;
              if (oldest) identityCache.delete(oldest);
            }
          }
          identityCache.set(key, { response: res, expiresAt: Date.now() + 60_000 });
        } else if (res.status === 401) {
          identityCache.delete(key);
        }
      }
      return res;
    }).catch((err) => {
      if (key) inflightIdentity.delete(key);
      throw err;
    });
    if (key) inflightIdentity.set(key, lookup);
    return lookup;
  };

  const resolveCaller = async (req: IncomingMessage): Promise<Caller | undefined> => {
    const identity = await resolveIdentity(sessionHeaders(req));
    const user = objectOf(identity.payload.user ?? objectOf(dataOf(identity)).user);
    if (!succeeded(identity) || typeof user.id !== 'string') return undefined;
    const userId = user.id;
    const admin = user.username === config.adminUsername || !!await store.get('user_settings', `${userId}:my-agent-admin`);
    return { userId, admin, identity: gatewayIdentityFor({ id: userId, username: user.username }, admin, options.env) };
  };
  const gatewayFor = (identity: GatewayIdentity) => identity ? new GatewayClient(config, identity) : gateway;

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
    getConversationMessages: service.getConversationMessages.bind(service),
    async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      let path: string;
      try { path = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname); }
      catch { sendJson(res, 400, { success: false, error: 'INVALID_PATH' }); return true; }
      // These loopback-only Core endpoints must never be exposed by the public proxy.
      if (path.startsWith('/api/auth/internal/') || req.headers['x-aioncore-bootstrap-secret']) {
        sendJson(res, 404, { success: false, error: 'NOT_FOUND' }); return true;
      }
      const method = req.method || 'GET';
      if (path === '/logout' || path === '/api/auth/logout' || path === '/api/auth/refresh') {
        const key = sessionKeyOf(sessionHeaders(req));
        if (key) identityCache.delete(key);
        return false;
      }
      if (path.startsWith('/api/myagent/')) {
        if (closed) { sendJson(res, 503, { success: false, error: 'BRIDGE_CLOSED' }); return true; }
        let caller: Caller | undefined;
        try { caller = await resolveCaller(req); }
        catch { sendJson(res, 502, { success: false, error: 'MY_AGENT_GATEWAY_UNAVAILABLE' }); return true; }
        // Legacy routes match the raw URL; the host path is decoded and may contain an encoded ID's slash.
        const rawGatewayPath = new URL(req.url || '/', 'http://localhost').pathname;
        if (caller && caller.identity === null && (isGatewayBridgePath(path) || isGatewayBridgePath(rawGatewayPath))) {
          sendJson(res, 403, { success: false, error: 'GATEWAY_IDENTITY_UNAVAILABLE' }); return true;
        }
        const scoped = gatewayFor(caller?.identity ?? undefined);
        if (path.startsWith('/api/myagent/sessions/progress/')) {
          if (!caller) { sendJson(res, 401, { success: false, error: 'AUTH_REQUIRED' }); return true; }
          return handleSessionProgress(req, res, path, scoped);
        }
        return handleMyAgentRoutes(req, res, { gateway: scoped, requireAuth: async () => caller !== undefined, requireCsrf: (r) => sameOrigin(r) });
      }
      if (isExternalConversationPath(path)) {
        if (closed) { sendJson(res, 503, { success: false, error: 'BRIDGE_CLOSED' }); return true; }
        return handleExternalConversation(req, res, path, method, { resolveCaller, gatewayFor });
      }
      const isAuthUserGet = path === '/api/auth/user' && method === 'GET';
      const tracked = isAuthUserGet || path === '/api/assistants' || path === '/api/agents/management' || path === '/api/providers' ||
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
        const identity = await resolveIdentity(headers);
        if (isAuthUserGet) {
          relayJson(res, identity);
          return true;
        }
        if (identity.status === 429) {
          relayJson(res, identity);
          return true;
        }
        const user = objectOf(identity.payload.user ?? objectOf(dataOf(identity)).user);
        if (!succeeded(identity) || typeof user.id !== 'string') {
          sendJson(res, 401, { success: false, error: 'AUTH_REQUIRED' }); return true;
        }
        const userId = user.id;
        const admin = user.username === config.adminUsername || !!await store.get('user_settings', `${userId}:my-agent-admin`);
        const body = ['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : await readJsonBody(req);
        const assistantId = objectOf(body?.assistant).id ?? body?.assistant_id;
        const useAdapter = assistantId === MY_AGENT_ID;
        if (admin && ((method === 'GET' && ['/api/assistants', '/api/agents/management', '/api/providers', '/api/settings/client'].includes(path)) || useAdapter)) {
          await ensureCatalog(userId, headers);
        } else if (useAdapter) { sendJson(res, 403, { success: false, error: 'ADMIN_REQUIRED' }); return true; }
        const response = await core(req.url || path, method, body, headers);
        if (response.status === 401) {
          const key = sessionKeyOf(headers);
          if (key) identityCache.delete(key);
        }
        committed = !['GET', 'HEAD'].includes(method) && succeeded(response);
        if (succeeded(response)) {
          let data = dataOf(response);
          if (path === '/api/providers' && method === 'GET' && admin) {
            const profiles = await resolveModels(userId);
            const provider = { id: MY_AGENT_ID, name: MY_AGENT_NAME, platform: 'custom', base_url: '', api_key: '', models: profiles.map((p) => p.model_name), readonly: true, profiles };
            data = [provider, ...(Array.isArray(data) ? data : [])];
            response.payload = { ...response.payload, data };
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
          if (path === '/api/conversations' && method === 'GET' && !new URL(req.url || '/', 'http://localhost').searchParams.has('cursor')) {
            const identity = gatewayIdentityFor({ id: userId, username: user.username }, admin, options.env);
            if (identity !== null) response.payload = await mergeGatewaySessions(gatewayFor(identity), userId, response.payload);
          }
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
