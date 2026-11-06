import { afterEach, describe, expect, it } from 'vitest';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GatewayClient, type JsonObject } from '../src/myagent/gateway.js';
import { loadMyAgentConfig } from '../src/myagent/config.js';
import { objectOf } from '../src/myagent/bootstrap.js';
import { readJsonBody, sendJson } from '../src/myagent/http.js';
import { requestJson } from '../src/myagent/io.js';
import { createMyAgentBridge } from '../src/myagent/service.js';
import {
  externalConversationId,
  gatewayIdentityFor,
  isExternalConversationPath,
  isGatewayBridgePath,
  mergeGatewaySessions,
  parseExternalConversationId,
} from '../src/myagent/sessions.js';

const servers: Server[] = [];
const bridges: Awaited<ReturnType<typeof createMyAgentBridge>>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0).reverse()) await bridge.close();
  for (const server of servers.splice(0).reverse()) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<string> {
  const server = http.createServer((req, res) => {
    void handler(req, res).catch(() => sendJson(res, 500, { error: 'TEST_HANDLER_FAILED' }));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_NOT_LISTENING');
  return `http://127.0.0.1:${address.port}`;
}

function session(conversationId: string, threadId: string, extra: JsonObject = {}): JsonObject {
  return {
    conversation_id: conversationId,
    thread_id: threadId,
    channel: 'chat',
    channel_user_id: 'local-agent',
    title: conversationId,
    created_at: 1.25,
    updated_at: 2.75,
    status: 'idle',
    in_flight: false,
    active_request_id: '',
    active_run_id: '',
    message_count: 2,
    preview: 'hello',
    ...extra,
  };
}

// Real loopback HTTP and private token files; these fixtures do not prove live Gateway compatibility.
async function fixture(env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp('/private/tmp/aionui-gateway-sessions-');
  directories.push(directory);
  const tokenFile = join(directory, 'gateway-token');
  await writeFile(tokenFile, 'fixture-gateway-token', { mode: 0o600 });
  const calls: { method: string; path: string; headers: http.IncomingHttpHeaders; body?: JsonObject }[] = [];
  const coreCalls: string[] = [];
  const coreList = { success: true, data: { items: [{ id: 'core-1', name: 'core' }], total: 1, has_more: false } };
  const state = { outage: false, rejectedHistory: false, missingThread: false };
  const gatewayUrl = await listen(async (req, res) => {
    const body = await readJsonBody(req);
    calls.push({ method: req.method || 'GET', path: req.url || '/', headers: req.headers, body });
    if (state.outage) {
      sendJson(res, 500, { ok: false });
      return;
    }
    if (req.url?.startsWith('/progress/')) {
      sendJson(res, 200, { ok: true, events: [{ kind: 'delta', text: 'hi' }], next: 4, private_key: 'not-relayed' });
      return;
    }
    if (body?.operation === 'list') {
      const scoped = typeof req.headers['x-user-id'] === 'string';
      const items = scoped
        ? [session('alice-session', 'alice-thread', { channel: 'local', channel_user_id: req.headers['x-user-id'] })]
        : [
            session('sess_one', 't1', { status: 'queued', in_flight: true, active_request_id: 'r1' }),
            session('sess_two', 't2'),
            session('aionui:u-admin:c1', 'core-thread'),
          ];
      sendJson(res, 200, { ok: true, owner_id: scoped ? 'local/alice' : 'local/main', items });
      return;
    }
    if (req.url === '/client/history') {
      if (state.rejectedHistory) {
        sendJson(res, 200, { ok: false, thread_id: '' });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        thread_id: state.missingThread ? '' : body?.target_thread_id,
        turns: [
          { request_id: 'old1', user_message: 'question', assistant_message: 'answer' },
          { request_id: 'old2', user_message: 'next question', assistant_message: 'next answer' },
        ],
        message_cursor: 16,
        before_message_cursor: 8,
        has_older: true,
        in_flight_status: 'processing',
        active_request_id: 'r1',
        progress_path: '/progress/r1',
      });
      return;
    }
    sendJson(res, 200, { ok: true });
  });
  const coreUrl = await listen(async (req, res) => {
    coreCalls.push(req.url || '/');
    if (req.url === '/api/auth/user') {
      const username = req.headers.cookie?.match(/fixture-user=([^;]+)/)?.[1];
      const names: Record<string, string> = {
        admin: 'admin',
        alice: 'alice',
        root: 'root',
        bad: 'al ice',
        main: 'Main',
      };
      if (!username || !names[username]) {
        sendJson(res, 401, { success: false });
        return;
      }
      sendJson(res, 200, { success: true, data: { user: { id: `u-${username}`, username: names[username] } } });
      return;
    }
    if (req.url?.startsWith('/api/conversations')) {
      sendJson(res, 200, coreList);
      return;
    }
    sendJson(res, 404, { success: false });
  });
  const bridge = await createMyAgentBridge({
    backendPort: Number(new URL(coreUrl).port),
    dataDir: directory,
    bootstrapSecret: '',
    env: {
      MY_AGENT_GATEWAY_URL: gatewayUrl,
      MY_AGENT_GATEWAY_TOKEN_FILE: tokenFile,
      MY_AGENT_ADMIN_USERNAME: 'admin',
      ...env,
    },
    runtime: { command: process.execPath, args: [] },
  });
  bridges.push(bridge);
  const hostUrl = await listen(async (req, res) => {
    if (!(await bridge.handleRequest(req, res))) sendJson(res, 404, { success: false, error: 'NOT_FOUND' });
  });
  const request = (
    path: string,
    user = 'admin',
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {}
  ) =>
    requestJson(hostUrl + path, {
      method,
      body,
      headers: { ...(user ? { cookie: `fixture-user=${user}` } : {}), ...headers },
    });
  const client = new GatewayClient(
    loadMyAgentConfig({ MY_AGENT_GATEWAY_URL: gatewayUrl, MY_AGENT_GATEWAY_TOKEN_FILE: tokenFile }),
    { userId: 'alice', channel: 'local' }
  );
  return { request, calls, coreCalls, state, coreList, bridge, client };
}

describe('Gateway sessions and per-user bridge identity', () => {
  it('non-admin approvals carry the caller identity', async () => {
    const { request, calls } = await fixture();
    expect((await request('/api/myagent/approvals', 'alice')).status).toBe(200);
    expect(calls[0]).toMatchObject({
      path: '/client/business',
      headers: { 'x-user-id': 'alice', 'x-channel': 'local', 'x-gateway-token': 'fixture-gateway-token' },
      body: { action: 'approvals.list' },
    });
    expect((await request('/api/myagent/approvals')).status).toBe(200);
    expect(calls[1].headers['x-user-id']).toBeUndefined();
    expect(calls[1].headers['x-channel']).toBeUndefined();
    expect(calls[1].headers['x-gateway-token']).toBe('fixture-gateway-token');
  });

  it('admin sees local TUI sessions merged into the first page', async () => {
    const { request, calls, bridge } = await fixture();
    const response = await request('/api/conversations');
    const data = objectOf(response.payload.data);
    const items = data.items as JsonObject[];
    expect(response.status).toBe(200);
    expect(items.map((row) => row.id)).toEqual([
      externalConversationId('sess_one', 't1'),
      externalConversationId('sess_two', 't2'),
      'core-1',
    ]);
    expect(data).toMatchObject({ total: 3, has_more: false });
    expect(items.slice(0, 2)).toMatchObject([
      { type: 'acp', source: 'my-agent', status: 'running', created_at: 1250, modified_at: 2750 },
      { type: 'acp', source: 'my-agent', status: 'finished' },
    ]);
    expect(items[0].extra).toEqual({
      gateway: {
        conversation_id: 'sess_one',
        thread_id: 't1',
        channel: 'chat',
        channel_user_id: 'local-agent',
        owner_id: 'local/main',
        status: 'queued',
        in_flight: true,
        active_request_id: 'r1',
        active_run_id: '',
        message_count: 2,
        preview: 'hello',
        read_only: true,
      },
    });
    expect(calls[0].body).toEqual({
      operation: 'list',
      conversation_id: 'aionui:u-admin:catalog',
      include_inflight: true,
    });
    expect(await bridge.store.list('conversations')).toEqual([]);
    calls.length = 0;
    expect((await request('/api/conversations?cursor=x')).payload.data).toEqual({
      items: [{ id: 'core-1', name: 'core' }],
      total: 1,
      has_more: false,
    });
    expect(calls).toEqual([]);
  });

  it('alice sees only her sessions', async () => {
    const { request, calls } = await fixture();
    const result = await request('/api/conversations', 'alice');
    expect((objectOf(result.payload.data).items as JsonObject[]).map((row) => row.id)).toEqual([
      externalConversationId('alice-session', 'alice-thread'),
      'core-1',
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers).toMatchObject({ 'x-user-id': 'alice', 'x-channel': 'local' });
  });

  it('reserved or invalid usernames never reach the gateway', async () => {
    for (const username of ['admin', 'Main', 'local-agent', 'anonymous', 'al ice', 'a'.repeat(65)])
      expect(gatewayIdentityFor({ id: 'u', username }, false, {})).toBeNull();
    for (const channel of ['chat', 'terminal', 'http', 'gateway-cli', 'cli'])
      expect(
        gatewayIdentityFor({ id: 'u', username: 'alice' }, false, { MY_AGENT_GATEWAY_USER_CHANNEL: channel })
      ).toBeNull();
    expect(gatewayIdentityFor({ id: 'u-root', username: 'root' }, false, {})).toEqual({
      userId: 'root',
      channel: 'local',
    });
    expect(
      gatewayIdentityFor({ id: 'u', username: 'al ice' }, true, { MY_AGENT_GATEWAY_USER_CHANNEL: 'chat' })
    ).toBeUndefined();
    const { request, calls, coreList } = await fixture();
    expect(await request('/api/myagent/approvals', 'bad')).toMatchObject({
      status: 403,
      payload: { success: false, error: 'GATEWAY_IDENTITY_UNAVAILABLE' },
    });
    expect((await request('/api/conversations', 'bad')).payload).toEqual(coreList);
    expect(calls).toEqual([]);
  });

  it('external session messages come from target_thread_id history', async () => {
    const { request, calls } = await fixture();
    const id = externalConversationId('alice-session', 'alice-thread');
    const response = await request(`/api/conversations/${id}/messages?limit=10`, 'alice');
    expect(calls[0]).toMatchObject({
      headers: { 'x-user-id': 'alice', 'x-channel': 'local' },
      body: { conversation_id: 'alice-session', target_thread_id: 'alice-thread', limit: 10 },
    });
    const page = objectOf(response.payload.data);
    expect(page).toMatchObject({
      oldest_cursor: '8',
      newest_cursor: '16',
      has_more_before: true,
      has_more_after: false,
    });
    expect(page.items).toEqual([
      {
        id: `${id}:old1:u`,
        conversation_id: id,
        type: 'text',
        position: 'right',
        content: { content: 'question' },
        status: 'finish',
      },
      {
        id: `${id}:old1:a`,
        conversation_id: id,
        type: 'text',
        position: 'left',
        content: { content: 'answer' },
        status: 'finish',
      },
      {
        id: `${id}:old2:u`,
        conversation_id: id,
        type: 'text',
        position: 'right',
        content: { content: 'next question' },
        status: 'finish',
      },
      {
        id: `${id}:old2:a`,
        conversation_id: id,
        type: 'text',
        position: 'left',
        content: { content: 'next answer' },
        status: 'finish',
      },
      {
        id: `${id}:r1:work`,
        conversation_id: id,
        type: 'tips',
        position: 'left',
        status: 'work',
        content: { content: 'Gateway 会话运行中', active_request_id: 'r1', progress_path: '/progress/r1' },
      },
    ]);
    await request(`/api/conversations/${id}/messages?limit=10&before=12`, 'alice');
    expect(calls[1].body).toEqual({
      conversation_id: 'alice-session',
      target_thread_id: 'alice-thread',
      limit: 10,
      before_message_cursor: 12,
    });
    expect(await request(`/api/conversations/${id}`, 'alice')).toMatchObject({
      status: 200,
      payload: {
        success: true,
        data: { id, name: 'alice-session', type: 'acp', source: 'my-agent', status: 'running' },
      },
    });
    expect(calls[2].body).toEqual({ conversation_id: 'alice-session', target_thread_id: 'alice-thread', limit: 1 });
    expect((await request('/api/conversations/myagent-gw-not-json')).status).toBe(404);
    expect(await request('/api/myagent/sessions/progress/r1?since=3', 'alice')).toMatchObject({
      status: 200,
      payload: { success: true, data: { events: [{ kind: 'delta', text: 'hi' }], next: 4 } },
    });
    expect(calls[3]).toMatchObject({
      method: 'GET',
      path: '/progress/r1?since=3',
      headers: { 'x-user-id': 'alice', 'x-channel': 'local' },
      body: undefined,
    });
    expect((await request('/api/myagent/sessions/progress/r1?since=-1', 'alice')).status).toBe(400);
    expect(calls).toHaveLength(4);
  });

  it('external sessions are read only', async () => {
    const { request, calls, coreCalls } = await fixture();
    await request('/api/myagent/status', 'alice');
    calls.length = 0;
    coreCalls.length = 0;
    const path = `/api/conversations/${externalConversationId('alice-session', 'alice-thread')}`;
    for (const suffix of ['', '/messages', '/other']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(await request(path + suffix, 'alice', method)).toMatchObject({
          status: 409,
          payload: { success: false, error: 'EXTERNAL_SESSION_READ_ONLY' },
        });
      }
    }
    expect(await request(path, 'alice', 'POST', {}, { origin: 'https://cross-site.invalid' })).toMatchObject({
      status: 403,
      payload: { error: 'CROSS_SITE_REQUEST' },
    });
    expect(calls).toEqual([]);
    expect(coreCalls).toEqual([]);
  });

  it('gateway outage keeps the core list', async () => {
    const { request, calls, coreList, state } = await fixture();
    state.outage = true;
    expect(await request('/api/conversations', 'alice')).toMatchObject({
      status: 200,
      payload: { ...coreList, gateway_error: 'MY_AGENT_GATEWAY_UNAVAILABLE' },
    });
    expect(
      await request(`/api/conversations/${externalConversationId('alice-session', 'alice-thread')}/messages`, 'alice')
    ).toMatchObject({ status: 502, payload: { error: 'MY_AGENT_GATEWAY_UNAVAILABLE' } });
    expect(await request('/api/myagent/sessions/progress/r1', 'alice')).toMatchObject({
      status: 502,
      payload: { error: 'MY_AGENT_GATEWAY_UNAVAILABLE' },
    });
    expect(calls.every((call) => call.headers['x-user-id'] === 'alice' && call.headers['x-channel'] === 'local')).toBe(
      true
    );
  });

  it('never merges a list with an explicitly empty cursor', async () => {
    const { request, calls, coreList } = await fixture();
    expect((await request('/api/conversations?cursor=', 'alice')).payload).toEqual(coreList);
    expect(calls).toEqual([]);
  });

  it.each([
    '/api/myagent/status',
    '/api/myagent/skills',
    '/api/myagent/approvals',
    '/api/myagent/sessions/progress/r1',
  ])('scopes %s and rejects an unavailable identity without fallback', async (path) => {
    const { request, calls } = await fixture();
    expect((await request(path, 'alice', 'GET', undefined, { 'x-user-id': 'admin', 'x-channel': 'chat' })).status).toBe(
      200
    );
    expect(calls[0].headers).toMatchObject({ 'x-user-id': 'alice', 'x-channel': 'local' });
    expect((await request(path, 'bad')).status).toBe(403);
    expect((await request(path, '')).status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it.each(['a%2Fb', '%2F', 'a%252Fb'])('rejects unavailable identities on encoded approval id %s', async (id) => {
    for (const [user, env] of [
      ['bad', {}],
      ['alice', { MY_AGENT_GATEWAY_USER_CHANNEL: 'CHAT' }],
    ] as const) {
      const { request, calls } = await fixture(env);
      const response = await request(`/api/myagent/approvals/${id}/decide`, user, 'POST', { decision: 'deny' });
      expect(response).toMatchObject({
        status: 403,
        payload: { success: false, error: 'GATEWAY_IDENTITY_UNAVAILABLE' },
      });
      expect(calls).toEqual([]);
    }
  });

  it('keeps valid callers scoped when an approval id contains an encoded slash', async () => {
    const { request, calls } = await fixture();
    expect((await request('/api/myagent/approvals/a%2Fb/decide', 'alice', 'POST', { decision: 'deny' })).status).toBe(
      200
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      headers: { 'x-user-id': 'alice', 'x-channel': 'local' },
      body: { params: { approval_id: 'a/b', decision: 'deny' } },
    });
  });

  it('scopes approval decisions and honors the persisted admin rule', async () => {
    const { request, calls, bridge } = await fixture();
    expect((await request('/api/myagent/approvals/a1/decide', 'alice', 'POST', { decision: 'deny' })).status).toBe(200);
    expect(calls[0]).toMatchObject({
      headers: { 'x-user-id': 'alice', 'x-channel': 'local' },
      body: { action: 'approvals.decide', params: { approval_id: 'a1', decision: 'deny' } },
    });
    await bridge.store.write([{ table: 'user_settings', key: 'u-alice:my-agent-admin', value: { username: 'admin' } }]);
    expect((await request('/api/myagent/skills', 'alice')).status).toBe(200);
    expect(calls[1].headers['x-user-id']).toBeUndefined();
    expect(calls[1].headers['x-channel']).toBeUndefined();
  });

  it('handles root as an ordinary user and rejects an unsafe deployment channel', async () => {
    const normal = await fixture();
    expect((await normal.request('/api/myagent/approvals', 'root')).status).toBe(200);
    expect(normal.calls[0].headers).toMatchObject({ 'x-user-id': 'root', 'x-channel': 'local' });
    const unsafe = await fixture({ MY_AGENT_GATEWAY_USER_CHANNEL: 'CHAT' });
    expect((await unsafe.request('/api/myagent/status', 'alice')).status).toBe(403);
    expect((await unsafe.request('/api/conversations', 'alice')).payload).toEqual(unsafe.coreList);
    expect(unsafe.calls).toEqual([]);
  });

  it('authenticates external reads, handles missing history, and intercepts latest without upstream reads', async () => {
    const { request, calls, state, bridge } = await fixture();
    const path = `/api/conversations/${externalConversationId('alice-session', 'alice-thread')}`;
    expect((await request(path, '')).status).toBe(401);
    expect((await request(path, 'bad')).status).toBe(404);
    expect((await request(path + '/other', 'alice')).status).toBe(404);
    expect((await request(path + '/messages/latest', 'alice')).payload).toEqual({ success: true, data: null });
    expect(calls).toEqual([]);
    state.missingThread = true;
    expect((await request(path, 'alice')).status).toBe(404);
    state.rejectedHistory = true;
    expect((await request(path, 'alice')).status).toBe(404);
    expect(await bridge.store.list('conversations')).toEqual([]);
    expect(await bridge.store.list('messages')).toEqual([]);
  });

  it.each(['limit=0', 'limit=101', 'limit=1.5', 'limit=', 'before=-1', 'before=1.5', 'before=9007199254740992'])(
    'rejects invalid history query %s before upstream access',
    async (query) => {
      const { request, calls } = await fixture();
      expect(
        (await request(`/api/conversations/${externalConversationId('s', 't')}/messages?${query}`, 'alice')).status
      ).toBe(400);
      expect(calls).toEqual([]);
    }
  );

  it.each(['since=-1', 'since=1.5', 'since=9007199254740992', 'since=', 'since=NaN'])(
    'rejects invalid progress query %s before upstream access',
    async (query) => {
      const { request, calls } = await fixture();
      expect((await request(`/api/myagent/sessions/progress/r1?${query}`, 'alice')).status).toBe(400);
      expect(calls).toEqual([]);
    }
  );

  it('rejects malformed progress IDs and non-GET progress requests', async () => {
    const { request, calls } = await fixture();
    for (const id of ['', 'a/b', 'a'.repeat(241), 'bad%20id'])
      expect((await request(`/api/myagent/sessions/progress/${id}`, 'alice')).status).toBe(400);
    expect(await request('/api/myagent/sessions/progress/r1', 'alice', 'POST')).toMatchObject({
      status: 405,
      headers: { allow: 'GET' },
    });
    expect(calls).toEqual([]);
  });

  it('preserves cursor zero and optional Gateway client arguments', async () => {
    const { client, calls } = await fixture();
    await client.listSessions('catalog', 'next');
    await client.sessionHistory('s', 't', 10, 0);
    await client.progress('r:1', 0);
    expect(calls.map(({ path, body }) => ({ path, body }))).toEqual([
      {
        path: '/client/history',
        body: { operation: 'list', conversation_id: 'catalog', include_inflight: true, cursor: 'next' },
      },
      {
        path: '/client/history',
        body: { conversation_id: 's', target_thread_id: 't', limit: 10, before_message_cursor: 0 },
      },
      { path: '/progress/r%3A1?since=0', body: undefined },
    ]);
    for (const [id, since] of [
      ['bad/id', 0],
      ['', 0],
      ['r1', -1],
      ['r1', 0.1],
      ['r1', Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      await expect(client.progress(id, since)).rejects.toThrow('INVALID_GATEWAY_PROGRESS');
    }
    expect(calls).toHaveLength(3);
  });
});

describe('Gateway session mapping boundaries', () => {
  it('round-trips public identifiers and reserves external subroutes', () => {
    const id = externalConversationId('sess_你好:1', 'thread-1');
    expect(parseExternalConversationId(id)).toEqual({ conversationId: 'sess_你好:1', threadId: 'thread-1' });
    expect(id).toMatch(/^myagent-gw-[A-Za-z0-9_-]+$/);
    expect(isExternalConversationPath(`/api/conversations/${id}/messages/latest`)).toBe(true);
    expect(isExternalConversationPath('/api/conversations/core-1/messages')).toBe(false);
  });

  it.each(['not-prefixed', 'myagent-gw-', 'myagent-gw-abc=', 'myagent-gw-!', 'myagent-gw-' + 'a'.repeat(1024)])(
    'rejects malformed ID %s',
    (id) => {
      expect(parseExternalConversationId(id)).toBeNull();
    }
  );

  it.each([
    'not-json',
    '{}',
    '["s"]',
    '["s","t","extra"]',
    '["", "t"]',
    '[1, "t"]',
    JSON.stringify(['s'.repeat(513), 't']),
  ])('rejects a malformed decoded payload %#', (payload) => {
    expect(parseExternalConversationId('myagent-gw-' + Buffer.from(payload).toString('base64url'))).toBeNull();
  });

  it('accepts boundary identity lengths and safe custom channels only', () => {
    expect(
      gatewayIdentityFor({ id: 'u', username: 'a'.repeat(64) }, false, {
        MY_AGENT_GATEWAY_USER_CHANNEL: 'c'.repeat(32),
      })
    ).toEqual({ userId: 'a'.repeat(64), channel: 'c'.repeat(32) });
    for (const username of [undefined, null, 1, '', ' alice', 'alice/', 'ADMIN', 'ANONYMOUS'])
      expect(gatewayIdentityFor({ id: 'u', username }, false, {})).toBeNull();
    for (const channel of ['c'.repeat(33), 'a b', '../local', 'CLI'])
      expect(
        gatewayIdentityFor({ id: 'u', username: 'alice' }, false, { MY_AGENT_GATEWAY_USER_CHANNEL: channel })
      ).toBeNull();
    expect(isGatewayBridgePath('/api/myagent/approvals/a1/decide')).toBe(true);
    expect(isGatewayBridgePath('/api/myagent/unknown')).toBe(false);
  });

  it('deduplicates portal prefixes and preserves array and paginated Core shapes', async () => {
    const gateway = {
      listSessions: async () => ({
        ok: true,
        owner_id: 'local/main',
        items: [
          session('sess_one', 't1'),
          session('aionui:u:c', 't2'),
          session('apagent-conv-1', 't3'),
          session('apagent-task-1', 't4'),
        ],
      }),
    };
    const core = [{ id: 'core-1' }];
    const array = await mergeGatewaySessions(gateway, 'u', { success: true, data: core });
    expect((array.data as JsonObject[]).map((row) => row.id)).toEqual([
      externalConversationId('sess_one', 't1'),
      'core-1',
    ]);
    expect(
      await mergeGatewaySessions(gateway, 'u', { data: { items: core, total: 7, has_more: true, cursor: 'core-next' } })
    ).toMatchObject({ data: { total: 8, has_more: true, cursor: 'core-next' } });
    const unsupported = { success: true, data: { unrelated: true } };
    expect(await mergeGatewaySessions(gateway, 'u', unsupported)).toBe(unsupported);
    expect(core).toEqual([{ id: 'core-1' }]);
  });

  it('keeps Core payloads intact when the Gateway throws or returns a failed catalog', async () => {
    const payload = { success: true, data: [] };
    const throwing = {
      listSessions: async (): Promise<JsonObject> => {
        throw new Error('private upstream error');
      },
    };
    expect(await mergeGatewaySessions(throwing, 'u', payload)).toEqual({
      ...payload,
      gateway_error: 'MY_AGENT_GATEWAY_UNAVAILABLE',
    });
    expect(await mergeGatewaySessions({ listSessions: async () => ({ ok: false }) }, 'u', payload)).toEqual({
      ...payload,
      gateway_error: 'MY_AGENT_GATEWAY_UNAVAILABLE',
    });
    expect(payload).toEqual({ success: true, data: [] });
  });
});
