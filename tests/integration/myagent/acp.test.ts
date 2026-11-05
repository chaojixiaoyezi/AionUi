import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createAcpAgent } from '../../../packages/web-host/src/myagent/acp';
import { GatewayClient } from '../../../packages/web-host/src/myagent/gateway';
import { loadMyAgentConfig } from '../../../packages/web-host/src/myagent/config';

// Contract fixture, not a production fallback. Live tests use the actual Gateway.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += String(chunk);
    const body = text ? JSON.parse(text) : {};
    calls.push({ path: req.url!, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/client/models') res.end(JSON.stringify({ ok: true, profiles: [{ id: 'profile-1', model_name: 'real-profile-model' }], current_profile_id: 'profile-1' }));
    else if (req.url === '/ask') res.end(JSON.stringify({ request_id: 'request-1' }));
    else if (req.url!.startsWith('/progress/')) res.end(JSON.stringify({ next: 17, events: [] }));
    else if (req.url === '/result/request-1') res.end(JSON.stringify({ status: 'done', ok: true, response: 'canonical Gateway answer' }));
    else if (req.url === '/client/history' || req.url === '/control') res.end(JSON.stringify({ ok: true }));
    else res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  const client = new GatewayClient(loadMyAgentConfig({ MY_AGENT_GATEWAY_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  const updates: Record<string, unknown>[] = [];
  const agent = createAcpAgent(client, (update) => updates.push(update));
  return { agent, updates, calls };
}
describe('my-agent ACP Gateway adapter', () => {
  it('advertises only implemented capabilities, never client filesystem/MCP execution', async () => {
    const { agent } = await fixture();
    expect(await agent.request('initialize', { protocolVersion: 1 })).toMatchObject({ protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { stdio: false, http: false, sse: false } } });
  });
  it('discovers real Gateway profiles and routes prompts through ask/progress/result', async () => {
    const { agent, updates, calls } = await fixture();
    const created = await agent.request('session/new', { cwd: '/authorized/workspace', mcpServers: [] });
    expect(created.models).toMatchObject({ currentModelId: 'profile-1', availableModels: [{ modelId: 'profile-1', name: 'real-profile-model' }] });
    const reply = await agent.request('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'inspect requested file' }] });
    expect(reply).toEqual({ stopReason: 'end_turn' });
    expect(updates).toContainEqual({ sessionId: created.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'canonical Gateway answer' } } });
    const ask = calls.find((call) => call.path === '/ask')!;
    expect(ask.body.goal).toContain('inspect requested file');
    expect(ask.body.goal).toContain('/authorized/workspace');
    expect(ask.body.conversation_id).toBe(`aionui:acp:${created.sessionId}`);
    expect(calls.map((call) => call.path)).toContain('/progress/request-1?since=0');
    expect(calls.map((call) => call.path)).toContain('/result/request-1');
  });
  it('retains session identity on resume and verifies history against Gateway', async () => {
    const { agent, calls } = await fixture();
    const created = await agent.request('session/new', { cwd: '/project' });
    await agent.request('session/load', { sessionId: created.sessionId, cwd: '/project' });
    expect(calls.find((call) => call.path === '/client/history')?.body).toMatchObject({ conversation_id: `aionui:acp:${created.sessionId}` });
  });
  it('selects only a real advertised profile using the Gateway native select operation', async () => {
    const { agent, calls } = await fixture();
    const created = await agent.request('session/new', { cwd: '/project' });
    await agent.request('session/set_model', { sessionId: created.sessionId, modelId: 'profile-1' });
    expect(calls).toContainEqual({ path: '/client/models', body: { operation: 'select', profile_id: 'profile-1', conversation_id: `aionui:acp:${created.sessionId}` } });
    await expect(agent.request('session/set_model', { sessionId: created.sessionId, modelId: 'not-advertised' })).rejects.toThrow();
  });
  it('rejects unowned sessions and unsupported requests rather than manufacturing responses', async () => {
    const { agent } = await fixture();
    await expect(agent.request('session/prompt', { sessionId: 'unknown', prompt: [{ type: 'text', text: 'hello' }] })).rejects.toThrow();
    await expect(agent.request('not/a/method', {})).rejects.toThrow();
  });
});
