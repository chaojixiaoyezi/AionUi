import { afterEach, describe, expect, it } from 'vitest';
import { scryptSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createMyAgentBridge } from '../../../packages/web-host/src/myagent/service';
import { startStaticServer } from '../../../packages/web-host/src/static-server';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
// Real HTTP entry with explicit Core/Gateway contract fixtures, not live-backend proof.
async function fixture(envExtra: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'w3-web-entry-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.html'), '<title>fixture</title>');
  const file = join(dir, 'admin.json');
  const salt = Buffer.from('1234567890abcdef');
  await writeFile(file, JSON.stringify({ schema: 'admin_password.v1', algorithm: 'scrypt', n: 16384, r: 8, p: 1, salt: salt.toString('base64'), hash: scryptSync('synthetic-test-password', salt, 32).toString('base64'), updated_at: 1 }), { mode: 0o600 });
  const calls: { path: string; body: Record<string, unknown>; secret?: string; csrf?: string }[] = [];
  const assistants: Record<string, unknown>[] = [];
  const agents: Record<string, unknown>[] = [];
  let settings: Record<string, unknown> = {};
  const backend = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += String(c);
    const body = raw ? JSON.parse(raw) : {};
    const path = req.url!; calls.push({ path, body, secret: req.headers['x-aioncore-bootstrap-secret'] as string, csrf: req.headers['x-csrf-token'] as string });
    res.setHeader('content-type', 'application/json');
    const reply = (data: unknown) => res.end(JSON.stringify({ success: true, data }));
    if (path === '/login') { res.writeHead(body.password === 'native-test-password' ? 200 : 401); res.end(JSON.stringify({ success: body.password === 'native-test-password' })); return; }
    if (path.startsWith('/api/auth/internal/')) {
      if (req.headers['x-aioncore-bootstrap-secret'] !== 'synthetic-bootstrap') { res.writeHead(401).end('{}'); return; }
      if (path.endsWith('/external-sessions')) { res.setHeader('set-cookie', ['aionui-session=core-signed-fixture; HttpOnly; Path=/', 'aionui-refresh=core-refresh-fixture; HttpOnly; Path=/']); reply({ user: { id: 'admin-user', username: 'admin' } }); return; }
      reply({ user_id: 'admin-user' }); return;
    }
    if (!req.headers.cookie?.includes('aionui-session=core-signed-fixture')) { res.writeHead(401).end(JSON.stringify({ success: false })); return; }
    if (path === '/api/auth/user') { res.end(JSON.stringify({ success: true, user: { id: 'admin-user', username: 'admin' } })); return; }
    if (path === '/api/agents/management') { reply(agents); return; }
    if (path === '/api/agents/custom') { const agent = { id: 'real-core-agent-id', ...body, enabled: true }; agents.push(agent); reply(agent); return; }
    if (path === '/api/assistants' && req.method === 'POST') { assistants.push({ ...body, enabled: true }); reply(assistants.at(-1)); return; }
    if (path === '/api/assistants') { reply(assistants); return; }
    if (path.endsWith('/state')) { reply({ enabled: true }); return; }
    if (path === '/api/settings/client') { if (req.method === 'PUT') settings = body; reply(settings); return; }
    if (path === '/api/providers') { reply([]); return; }
    if (path === '/api/conversations' && req.method === 'POST') { reply({ id: 'conversation-1', type: 'acp', name: 'fixture-conversation', extra: { backend: 'real-core-agent-id' } }); return; }
    if (path === '/api/conversations/conversation-1') { reply({ id: 'conversation-1', type: 'acp', extra: { backend: 'real-core-agent-id' }, runtime: { status: 'idle' } }); return; }
    if (path === '/api/conversations/conversation-1/messages') { reply([{ id: 'message-1', conversation_id: 'conversation-1', content: 'persisted native message' }]); return; }
    reply({});
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => backend.close(() => r())));
  const bridge = await createMyAgentBridge({ backendPort: (backend.address() as { port: number }).port, dataDir: dir,
    bootstrapSecret: 'synthetic-bootstrap', env: { MY_AGENT_ADMIN_PASSWORD_FILE: file, ...envExtra }, runtime: { command: 'bun', args: ['/trusted/adapter.ts'] } });
  cleanup.push(() => bridge.close());
  const host = await startStaticServer({ staticDir: dir, backendPort: (backend.address() as { port: number }).port, port: 0, requestHandler: bridge.handleRequest });
  cleanup.push(() => host.stop());
  const cookie = 'aionui-session=core-signed-fixture';
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const init: RequestInit = { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(host.localUrl + path, init);
  };
  return { request, bridge, calls, cookie, dir };
}
describe('my-agent WebUI wiring', () => {
  it('verifies native scrypt then exchanges for Core-signed cookies without rewriting native password tables', async () => {
    const { request, calls } = await fixture();
    const r = await request('/login', 'POST', { username: 'admin', password: 'synthetic-test-password' });
    expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ success: true, user: { id: 'admin-user' } });
    expect(r.headers.get('set-cookie')).toContain('core-signed-fixture');
    expect(calls.find((c) => c.path.endsWith('/external-sessions'))?.body).toEqual({ user_type: 'aionpro', external_user_id: 'my-agent:admin' });
    expect(calls.some((c) => c.path.includes('/password') || c.path.includes('/credentials'))).toBe(false);
  });
  it('retains native password login and never provisions an external user for invalid credentials or another username', async () => {
    const { request, calls } = await fixture();
    expect((await request('/login', 'POST', { username: 'admin', password: 'native-test-password' })).status).toBe(200);
    expect((await request('/login', 'POST', { username: 'another', password: 'synthetic-test-password' })).status).toBe(401);
    expect((await request('/login', 'POST', { username: 'admin', password: 'wrong' })).status).toBe(401);
    expect(calls.some((c) => c.path.includes('/external-'))).toBe(false);
  });
  it('blocks public bootstrap endpoints even when a client guesses the deployment secret', async () => {
    const { request } = await fixture();
    expect((await request('/api/auth/internal/external-sessions', 'POST', {}, { 'x-aioncore-bootstrap-secret': 'synthetic-bootstrap' })).status).toBe(404);
  });
  it('rejects cross-site login before any password verifier or Core account writes', async () => {
    const { request, calls } = await fixture();
    expect((await request('/login', 'POST', { username: 'admin', password: 'synthetic-test-password' }, { origin: 'https://untrusted.invalid' })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it('registers the default enabled assistant once, bound to the actual Core custom-agent id', async () => {
    const { request, calls, cookie, bridge } = await fixture();
    for (let i = 0; i < 2; i++) {
      const response = await request('/api/assistants', 'GET', undefined, { cookie });
      expect(response.status).toBe(200); expect((await response.json()).data).toContainEqual(expect.objectContaining({ id: 'my-agent', agent_id: 'real-core-agent-id' }));
    }
    expect(calls.filter((c) => c.path === '/api/agents/custom')).toHaveLength(1);
    expect(await bridge.store.get('agent_bindings', 'admin-user:my-agent')).toMatchObject({ agent_id: 'real-core-agent-id' });
  });
  it('double-writes application conversations, messages, settings and sync metadata, scoped to authenticated user', async () => {
    const { request, bridge, cookie } = await fixture();
    expect((await request('/api/conversations', 'POST', { assistant: { id: 'my-agent' }, extra: {} }, { cookie })).status).toBe(200);
    expect((await request('/api/conversations/conversation-1/messages', 'GET', undefined, { cookie })).status).toBe(200);
    expect((await request('/api/settings/client', 'PUT', { language: 'zh-CN' }, { cookie })).status).toBe(200);
    expect(await bridge.store.get('conversations', 'admin-user:conversation-1')).toMatchObject({ id: 'conversation-1' });
    expect(await bridge.store.get('messages', 'admin-user:conversation-1:message-1')).toMatchObject({ content: 'persisted native message' });
    expect(await bridge.store.get('user_settings', 'admin-user:client')).toMatchObject({ language: 'zh-CN' });
    expect((await bridge.store.list('sync_metadata', 'admin-user:')).length).toBeGreaterThan(0);
    expect((await request('/api/settings/client')).status).toBe(401);
  });
  it('deduplicates concurrent /api/auth/user lookups and injects x-csrf-token on same-origin non-tracked POSTs', async () => {
    const { request, calls, cookie } = await fixture();
    const fullCookie = `${cookie}; aionui-csrf-token=csrf-double-submit-123`;
    const responses = await Promise.all([
      request('/api/auth/user', 'GET', undefined, { cookie: fullCookie }),
      request('/api/settings/client', 'GET', undefined, { cookie: fullCookie }),
      request('/api/conversations/conversation-1', 'GET', undefined, { cookie: fullCookie }),
      request('/api/conversations/conversation-1/messages', 'GET', undefined, { cookie: fullCookie }),
      request('/api/fs/dir', 'POST', { path: '/var/lib/aionui' }, { cookie: fullCookie }),
      request('/api/conversations/conversation-1/runtime/ensure', 'POST', undefined, { cookie: fullCookie }),
    ]);
    for (const r of responses) expect(r.status).toBe(200);
    expect(calls.filter((c) => c.path === '/api/auth/user')).toHaveLength(1);
    expect(calls.find((c) => c.path === '/api/fs/dir')?.csrf).toBe('csrf-double-submit-123');
    expect(calls.find((c) => c.path === '/api/conversations/conversation-1/runtime/ensure')?.csrf).toBe('csrf-double-submit-123');
  });
});
