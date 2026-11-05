import type { CoreCall } from './http.js';
import { dataOf, succeeded } from './http.js';
import type { JsonObject } from './gateway.js';
import type { BridgeStore } from './store.js';

export const MY_AGENT_ID = 'my-agent';
export const MY_AGENT_NAME = 'my-agent（.10 研发编码底座）';
export type AdapterRuntime = { command: string; args: string[] };
export const objectOf = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};

/** Register through Core's real test-on-save ACP probe; never invent a catalog id. */
export function createCatalogBootstrap(core: CoreCall, store: BridgeStore, runtime: AdapterRuntime) {
  const running = new Map<string, Promise<string>>();
  const provision = async (userId: string, headers: Record<string, string>): Promise<string> => {
    const call: CoreCall = async (path, method, body) => {
      const response = await core(path, method, body, headers);
      if (!succeeded(response)) throw new Error('CORE_CATALOG_FAILED');
      return response;
    };
    const management = dataOf(await call('/api/agents/management'));
    if (!Array.isArray(management)) throw new Error('INVALID_CORE_AGENTS');
    const previous = objectOf(await store.get('agent_bindings', `${userId}:${MY_AGENT_ID}`));
    let agent = (management as JsonObject[]).find((row) => row.id === previous.agent_id &&
      row.command === runtime.command && JSON.stringify(row.args || []) === JSON.stringify(runtime.args));
    // Recover an interrupted first registration without relying on a user-editable display name alone.
    agent ??= (management as JsonObject[]).find((row) => row.name === MY_AGENT_NAME &&
      row.command === runtime.command && JSON.stringify(row.args || []) === JSON.stringify(runtime.args));
    if (!agent) agent = objectOf(dataOf(await call('/api/agents/custom', 'POST', {
      name: MY_AGENT_NAME, command: runtime.command, args: runtime.args,
      advanced: { description: 'Routes coding tasks to the configured my-agent Gateway via ACP.' },
    })));
    if (typeof agent.id !== 'string' || !agent.id) throw new Error('INVALID_CORE_AGENT_ID');
    const agentId = agent.id;
    // Save the server-generated id before the next write, so retries cannot duplicate the agent.
    await store.write([{ table: 'agent_bindings', key: `${userId}:${MY_AGENT_ID}`, value: { agent_id: agentId, command: runtime.command, args: runtime.args } }]);
    const catalog = dataOf(await call('/api/assistants'));
    if (!Array.isArray(catalog)) throw new Error('INVALID_CORE_ASSISTANTS');
    const assistant = (catalog as JsonObject[]).find((row) => row.id === MY_AGENT_ID);
    if (!assistant) {
      await call('/api/assistants', 'POST', { id: MY_AGENT_ID, name: MY_AGENT_NAME, agent_id: agentId });
      await call(`/api/assistants/${MY_AGENT_ID}/state`, 'PATCH', { enabled: true });
    } else if (assistant.agent_id !== agentId) {
      await call(`/api/assistants/${MY_AGENT_ID}`, 'PUT', { agent_id: agentId });
    }
    const bareIds = new Set<string>([`bare:${agentId}`]);
    for (const row of management as JsonObject[]) {
      if (row.name === MY_AGENT_NAME && typeof row.id === 'string') bareIds.add(`bare:${row.id}`);
    }
    for (const row of catalog as JsonObject[]) {
      if (typeof row.id === 'string' && row.id.startsWith('bare:') && (bareIds.has(row.id) || row.name === MY_AGENT_NAME) && row.enabled !== false) {
        await core(`/api/assistants/${encodeURIComponent(row.id)}/state`, 'PATCH', { enabled: false }, headers).catch(() => undefined);
      }
    }
    const preferences = objectOf(dataOf(await call('/api/settings/client')));
    const lastAssistantId = preferences['guid.lastAssistantId'];
    if (lastAssistantId == null || (typeof lastAssistantId === 'string' && lastAssistantId.startsWith('bare:'))) {
      await call('/api/settings/client', 'PUT', { 'guid.lastAssistantId': MY_AGENT_ID });
    }
    return agentId;
  };
  return (userId: string, headers: Record<string, string>): Promise<string> => {
    let pending = running.get(userId);
    if (!pending) {
      pending = provision(userId, headers).catch((error: unknown) => { running.delete(userId); throw error; });
      running.set(userId, pending);
    }
    return pending;
  };
}
