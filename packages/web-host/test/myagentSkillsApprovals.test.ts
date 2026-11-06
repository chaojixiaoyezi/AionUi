import { afterEach, describe, expect, it } from 'vitest';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { GatewayClient, type JsonObject } from '../src/myagent/gateway.js';
import { loadMyAgentConfig } from '../src/myagent/config.js';
import { readJsonBody, sendJson } from '../src/myagent/http.js';
import { requestJson } from '../src/myagent/io.js';
import { handleMyAgentRoutes, type MyAgentRouteService } from '../src/myagent/routes.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
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

// Real HTTP transport with a local Gateway contract fixture, not a live deployment.
async function fixture(upstreamStatus = 200, upstreamPayload?: JsonObject) {
  const calls: { method: string; path: string; body?: JsonObject; headers: http.IncomingHttpHeaders }[] = [];
  const gatewayUrl = await listen(async (req, res) => {
    const body = await readJsonBody(req);
    calls.push({ method: req.method || 'GET', path: req.url || '/', body, headers: req.headers });
    const payload = req.url === '/status'
      ? { ok: true, service: 'gateway-fixture' }
      : { ok: true, data: { action: body?.action, params: body?.params } };
    sendJson(res, upstreamStatus, upstreamPayload ?? payload);
  });
  const gateway = new GatewayClient(loadMyAgentConfig({ MY_AGENT_GATEWAY_URL: gatewayUrl }));
  const gates: string[] = [];
  const service: MyAgentRouteService = {
    gateway,
    requireAuth: async (req) => {
      gates.push('auth');
      return req.headers.cookie?.split(';').some((part) => part.trim() === 'fixture-session=signed-test-session') === true;
    },
    requireCsrf: async (req) => {
      gates.push('csrf');
      const token = req.headers.cookie?.match(/(?:^|;\s*)aionui-csrf-token=([^;]+)/)?.[1];
      return !!token && req.headers['x-csrf-token'] === token;
    },
  };
  const hostUrl = await listen(async (req, res) => {
    if (!await handleMyAgentRoutes(req, res, service)) sendJson(res, 404, { error: 'NOT_FOUND' });
  });
  const authHeaders = { cookie: 'fixture-session=signed-test-session; aionui-csrf-token=fixture-csrf' };
  const csrfHeaders = { ...authHeaders, 'x-csrf-token': 'fixture-csrf' };
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = authHeaders) =>
    requestJson(hostUrl + path, { method, body, headers });
  return { gateway, calls, gates, service, request, hostUrl, authHeaders, csrfHeaders };
}

describe('Gateway skills and approvals HTTP contract', () => {
  it('reads status with GET and no request body', async () => {
    const { gateway, calls } = await fixture();
    expect(gateway.status).toBeTypeOf('function');
    expect(await gateway.status()).toEqual({ ok: true, service: 'gateway-fixture' });
    expect(calls).toMatchObject([{ method: 'GET', path: '/status', body: undefined }]);
  });

  it('sends business params with fresh request IDs and optional idempotency', async () => {
    const { gateway, calls } = await fixture();
    expect(gateway.business).toBeTypeOf('function');
    await gateway.business('skills.list');
    await gateway.business('skills.list', { limit: 7 }, 'stable-key');
    expect(calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'POST', path: '/client/business', body: { action: 'skills.list', request_id: expect.any(String), params: {} } },
      { method: 'POST', path: '/client/business', body: { action: 'skills.list', request_id: expect.any(String), params: { limit: 7 }, idempotency_key: 'stable-key' } },
    ]);
    expect(calls[0].body?.request_id).not.toBe(calls[1].body?.request_id);
  });

  it.each([
    ['listSkills', 'skills.list'],
    ['listApprovals', 'approvals.list'],
  ] as const)('%s forwards default and explicit params', async (method, action) => {
    const { gateway, calls } = await fixture();
    expect(gateway[method]).toBeTypeOf('function');
    expect(await gateway[method]()).toEqual({ ok: true, data: { action, params: {} } });
    await gateway[method]({ limit: 3 });
    expect(calls.map((call) => call.body)).toEqual([
      { action, request_id: expect.any(String), params: {} },
      { action, request_id: expect.any(String), params: { limit: 3 } },
    ]);
  });

  it.each([true, false])('sets the skill enabled state to %s', async (enabled) => {
    const { gateway, calls } = await fixture();
    expect(gateway.setSkillEnabled).toBeTypeOf('function');
    expect(await gateway.setSkillEnabled('owner:example', enabled)).toEqual({
      ok: true, data: { action: 'skills.set_enabled', params: { skill_id: 'owner:example', enabled } },
    });
    expect(calls[0].body).toMatchObject({ action: 'skills.set_enabled', params: { skill_id: 'owner:example', enabled } });
  });

  it.each(['approve', 'deny'] as const)('uses stable decision idempotency for %s', async (decision) => {
    const { gateway, calls } = await fixture();
    expect(gateway.decideApproval).toBeTypeOf('function');
    await gateway.decideApproval('approval-1', decision);
    await gateway.decideApproval('approval-1', decision);
    expect(calls.map((call) => call.body)).toEqual([0, 1].map(() => ({
      action: 'approvals.decide', request_id: expect.any(String),
      params: { approval_id: 'approval-1', decision }, idempotency_key: `decide-approval-1-${decision}`,
    })));
    expect(calls[0].body?.request_id).not.toBe(calls[1].body?.request_id);
  });

  it.each([401, 503])('propagates upstream HTTP %s without anonymous retries', async (status) => {
    const { gateway, calls } = await fixture(status);
    expect(gateway.listSkills).toBeTypeOf('function');
    await expect(gateway.listSkills()).rejects.toThrow(`GATEWAY_HTTP_${status}`);
    expect(calls).toHaveLength(1);
  });

  it('rejects a business failure in a successful HTTP response', async () => {
    const { gateway } = await fixture(200, { ok: false, error: 'fixture failure' });
    expect(gateway.listApprovals).toBeTypeOf('function');
    await expect(gateway.listApprovals()).rejects.toThrow('GATEWAY_HTTP_200');
  });

  it.each(['status', 'business', 'listSkills', 'setSkillEnabled', 'listApprovals', 'decideApproval'] as const)(
    '%s respects an already aborted signal', async (method) => {
      const { gateway, calls } = await fixture();
      expect(gateway[method]).toBeTypeOf('function');
      const signal = AbortSignal.abort();
      const invoke = () => {
        switch (method) {
          case 'status': return gateway.status(signal);
          case 'business': return gateway.business('skills.list', {}, undefined, signal);
          case 'listSkills': return gateway.listSkills({}, signal);
          case 'setSkillEnabled': return gateway.setSkillEnabled('owner:example', true, signal);
          case 'listApprovals': return gateway.listApprovals({}, signal);
          case 'decideApproval': return gateway.decideApproval('approval-1', 'approve', signal);
        }
      };
      await expect(invoke()).rejects.toThrow('REQUEST_CANCELLED');
      expect(calls).toHaveLength(0);
    },
  );
});

describe('exported my-agent HTTP route handler', () => {
  it.each([
    ['/api/myagent/status', { ok: true, service: 'gateway-fixture' }],
    ['/api/myagent/skills', { ok: true, data: { action: 'skills.list', params: {} } }],
    ['/api/myagent/approvals', { ok: true, data: { action: 'approvals.list', params: {} } }],
  ] as const)('serves authenticated GET %s over HTTP', async (path, payload) => {
    const { request, calls, gates } = await fixture();
    const result = await request(path);
    expect({ status: result.status, payload: result.payload }).toEqual({ status: 200, payload });
    expect(gates).toEqual(['auth']);
    expect(calls).toHaveLength(1);
  });

  it.each(['approve', 'deny'] as const)('forwards the %s decision only after auth and CSRF', async (decision) => {
    const { request, calls, gates, csrfHeaders } = await fixture();
    const response = await request('/api/myagent/approvals/approval%3A1/decide', 'POST', { decision }, csrfHeaders);
    expect({ status: response.status, payload: response.payload }).toEqual({
      status: 200, payload: { ok: true, data: { action: 'approvals.decide', params: { approval_id: 'approval:1', decision } } },
    });
    expect(gates).toEqual(['auth', 'csrf']);
    expect(calls[0].body?.idempotency_key).toBe(`decide-approval:1-${decision}`);
  });

  it.each(['/api/myagent/status', '/api/myagent/skills', '/api/myagent/approvals', '/api/myagent/approvals/a/decide'])(
    'rejects unauthenticated %s without touching Gateway', async (path) => {
      const { request, calls, gates } = await fixture();
      const result = await request(path, path.endsWith('/decide') ? 'POST' : 'GET', undefined, {});
      expect(result.status).toBe(401);
      expect(gates).toEqual(['auth']);
      expect(calls).toHaveLength(0);
    },
  );

  it.each([undefined, 'wrong-token'])('rejects missing or mismatched CSRF (%s)', async (token) => {
    const { request, calls, authHeaders } = await fixture();
    const result = await request('/api/myagent/approvals/a/decide', 'POST', { decision: 'approve' }, {
      ...authHeaders, ...(token ? { 'x-csrf-token': token } : {}),
    });
    expect(result.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['origin', 'https://untrusted.invalid'],
    ['sec-fetch-site', 'cross-site'],
  ])('blocks cross-site mutation (%s)', async (name, value) => {
    const { request, calls, csrfHeaders } = await fixture();
    const result = await request('/api/myagent/approvals/a/decide', 'POST', { decision: 'approve' }, { ...csrfHeaders, [name]: value });
    expect(result.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it.each([{}, { decision: 'accept' }, { decision: true }, { decision: ['approve'] }, null, []])('rejects invalid decision body %j', async (body) => {
    const { request, calls, csrfHeaders } = await fixture();
    const result = await request('/api/myagent/approvals/a/decide', 'POST', body, csrfHeaders);
    expect(result.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects malformed JSON rather than forwarding a mutation', async () => {
    const { hostUrl, calls, csrfHeaders } = await fixture();
    const result = await fetch(hostUrl + '/api/myagent/approvals/a/decide', {
      method: 'POST', headers: { ...csrfHeaders, 'content-type': 'application/json' }, body: '{',
    });
    expect(result.status).toBe(400);
    await result.json();
    expect(calls).toHaveLength(0);
  });

  it('requires JSON for decisions', async () => {
    const { hostUrl, calls, csrfHeaders } = await fixture();
    const result = await fetch(hostUrl + '/api/myagent/approvals/a/decide', {
      method: 'POST', headers: { ...csrfHeaders, 'content-type': 'text/plain' }, body: '{"decision":"approve"}',
    });
    expect(result.status).toBe(415);
    await result.json();
    expect(calls).toHaveLength(0);
  });

  it.each(['%E0%A4', '%00', '%20'])('rejects invalid approval IDs (%s)', async (id) => {
    const { request, calls, csrfHeaders } = await fixture();
    const result = await request(`/api/myagent/approvals/${id}/decide`, 'POST', { decision: 'approve' }, csrfHeaders);
    expect(result.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['/api/myagent/status', 'POST', 'GET'],
    ['/api/myagent/skills', 'DELETE', 'GET'],
    ['/api/myagent/approvals', 'PUT', 'GET'],
    ['/api/myagent/approvals/a/decide', 'GET', 'POST'],
  ])('rejects unsupported methods on %s', async (path, method, allow) => {
    const { request, calls } = await fixture();
    const result = await request(path, method);
    expect(result.status).toBe(405);
    expect(result.headers.allow).toBe(allow);
    expect(calls).toHaveLength(0);
  });

  it('leaves unrelated paths to the next handler', async () => {
    const { request, calls, gates } = await fixture();
    expect((await request('/api/elsewhere')).status).toBe(404);
    expect(gates).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('returns a sanitized upstream failure without claiming success', async () => {
    const { request } = await fixture(503, { ok: false, error: 'private upstream details' });
    const result = await request('/api/myagent/skills');
    expect({ status: result.status, payload: result.payload }).toEqual({
      status: 502, payload: { success: false, error: 'MY_AGENT_GATEWAY_UNAVAILABLE' },
    });
  });

  it('preserves a denial response already sent by a host guard', async () => {
    const { request, service, calls } = await fixture();
    service.requireAuth = async (_req, res) => { sendJson(res, 403, { error: 'ADMIN_REQUIRED' }); return false; };
    const response = await request('/api/myagent/approvals');
    expect({ status: response.status, payload: response.payload }).toEqual({ status: 403, payload: { error: 'ADMIN_REQUIRED' } });
    expect(calls).toHaveLength(0);
  });

  it('fails closed if a security gate throws', async () => {
    const { request, service, calls } = await fixture();
    service.requireCsrf = async () => { throw new Error('private verifier details'); };
    const response = await request('/api/myagent/approvals/a/decide', 'POST', { decision: 'approve' });
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.payload)).not.toContain('private verifier details');
    expect(calls).toHaveLength(0);
  });
});
