import { describe, expect, it } from 'vitest';
import { scryptSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startWebHost } from '../../../packages/web-host/src/index';
import { ENTITY_TABLES, openBridgeStore } from '../../../packages/web-host/src/myagent/store';

// Real official Core + real optional PostgreSQL + explicit Gateway wire fixture.
// This does NOT prove a deployed my-agent Gateway, remote host, browser, or model call.
describe.skipIf(!process.env.AIONUI_TEST_CORE_BIN)('official Core WebUI/ACP entry', () => {
  it('enforces login, probes the actual ACP process, runs a turn and persists application entities', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'w3-real-core-'));
    const calls: string[] = [];
    const gateway = http.createServer(async (req, res) => {
      calls.push(req.url || '');
      for await (const _chunk of req) { /* drain the fixture request */ }
      res.setHeader('content-type', 'application/json');
      if (req.url === '/client/models') res.end(JSON.stringify({ ok: true, profiles: [{ id: 'contract-profile', model_name: 'contract-model' }], current_profile_id: 'contract-profile' }));
      else if (req.url === '/ask') res.end(JSON.stringify({ request_id: 'contract-request' }));
      else if (req.url?.startsWith('/progress/')) res.end(JSON.stringify({ next: 1, events: [] }));
      else if (req.url === '/result/contract-request') res.end(JSON.stringify({ ok: true, status: 'done', response: 'canonical-contract-answer' }));
      else res.end(JSON.stringify({ ok: true, messages: [] }));
    });
    await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
    const passwordFile = join(dir, 'admin.json');
    const password = 'synthetic-core-integration-only';
    const salt = Buffer.from('1234567890abcdef');
    await writeFile(passwordFile, JSON.stringify({ schema: 'admin_password.v1', algorithm: 'scrypt', n: 16384, r: 8, p: 1,
      salt: salt.toString('base64'), hash: scryptSync(password, salt, 32).toString('base64'), updated_at: 1 }), { mode: 0o600 });
    await writeFile(join(dir, 'index.html'), '<title>Core integration fixture</title>');
    const env: NodeJS.ProcessEnv = { ...process.env, MY_AGENT_ADMIN_PASSWORD_FILE: passwordFile,
      MY_AGENT_GATEWAY_URL: `http://127.0.0.1:${(gateway.address() as { port: number }).port}`,
      ...(process.env.AIONUI_TEST_PG_DSN ? { AIONUI_PG_DSN: process.env.AIONUI_TEST_PG_DSN } : {}) };
    // A parent's live credential reference must never be sent to a fixture.
    env.MY_AGENT_GATEWAY_TOKEN_FILE = '';
    const runtime = { command: process.execPath, args: [createRequire(import.meta.url).resolve('tsx/cli'), resolve('scripts/checkMyAgentBridge.ts'), '--acp'] };
    let host: Awaited<ReturnType<typeof startWebHost>> | undefined;
    try {
      host = await startWebHost({ app: { version: '2.2.2', isPackaged: false, resourcesPath: process.cwd(), userDataPath: dir },
        staticDir: dir, port: 0, dataDir: dir, logDir: join(dir, 'logs'), dirs: { cacheDir: dir, workDir: dir, logDir: join(dir, 'logs') },
        backend: { kind: 'ownBackend', resolveBackend: () => process.env.AIONUI_TEST_CORE_BIN! }, myAgent: { env, runtime } });
      const request = (path: string, cookie = '', method = 'GET', body?: unknown) => {
        const init: RequestInit = { method, headers: { cookie, connection: 'close', 'content-type': 'application/json' } };
        if (body !== undefined) init.body = JSON.stringify(body);
        return fetch(host!.localUrl + path, init);
      };
      expect((await request('/api/assistants')).status).toBe(401);
      expect((await request('/api/auth/internal/external-sessions', '', 'POST', {})).status).toBe(404);
      const login = await request('/login', '', 'POST', { username: 'admin', password });
      const loginBody = await login.json();
      expect(login.status, JSON.stringify(loginBody)).toBe(200);
      const userId = loginBody.user.id as string;
      const cookie = login.headers.getSetCookie().map((v) => v.split(';')[0]).join('; ');
      const list = await request('/api/assistants', cookie);
      const catalog = await list.json();
      expect(list.status, JSON.stringify(catalog)).toBe(200);
      expect(catalog.data).toContainEqual(expect.objectContaining({ id: 'my-agent', enabled: true }));
      const assistant = catalog.data.find((a: { id: string }) => a.id === 'my-agent');
      expect(assistant.agent_id).toMatch(/^[a-f0-9]{8}$/);
      const providers = await (await request('/api/providers', cookie)).json();
      expect(providers.data).toContainEqual(expect.objectContaining({ id: 'my-agent', models: ['contract-model'] }));
      const created = await request('/api/conversations', cookie, 'POST', { name: 'Core ACP smoke', assistant: { id: 'my-agent' }, extra: { workspace: dir } });
      const conversation = await created.json();
      expect(created.status, JSON.stringify(conversation)).toBeLessThan(300);
      const conversationId = conversation.data.id as string;
      const sent = await request(`/api/conversations/${conversationId}/messages`, cookie, 'POST', { content: 'contract-message', loading_id: 'contract-loading' });
      const ack = await sent.json();
      expect(sent.status, JSON.stringify(ack)).toBeLessThan(300);
      let history = '';
      const deadline = Date.now() + 30000;
      while (!history.includes('canonical-contract-answer') && Date.now() < deadline) {
        history = JSON.stringify(await (await request(`/api/conversations/${conversationId}/messages`, cookie)).json());
        if (!history.includes('canonical-contract-answer')) await delay(300);
      }
      expect(history).toContain('canonical-contract-answer');
      expect(calls).toContain('/ask');
      await request('/api/settings/client', cookie, 'PUT', { language: 'zh-CN' });
      const reopened = await openBridgeStore(dir, env);
      try {
        for (const table of ENTITY_TABLES) expect((await reopened.list(table, `${userId}:`)).length, table).toBeGreaterThan(0);
      } finally { await reopened.close(); }
    } finally {
      await host?.stop();
      await new Promise<void>((r) => gateway.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  }, 120000);
});
