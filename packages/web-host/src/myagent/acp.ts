import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream, type Agent, type SessionNotification, type InitializeResponse, type NewSessionResponse, type LoadSessionResponse, type PromptResponse, type SetSessionModelResponse, type SetSessionConfigOptionResponse } from '@agentclientprotocol/sdk';
import type { GatewayClient, JsonObject } from './gateway.js';
import type { BridgeStore } from './store.js';

type AcpSession = { cwd: string; models: JsonObject; busy: boolean; abort?: AbortController };
export type AcpContext = { userId: string; conversationId: string; store: BridgeStore };

/** ACP stdio adapter: execution remains in the real Gateway, not this process. */
export function createAcpAgent(client: GatewayClient, notify: (params: JsonObject) => void | Promise<void>, context?: AcpContext) {
  const sessions = new Map<string, AcpSession>();
  const conversation = (id: string): string => context ? `aionui:${context.userId}:${context.conversationId}` : `aionui:acp:${id}`;
  const modelState = async (id: string): Promise<JsonObject> => {
    const catalog = await client.models(conversation(id));
    if (!Array.isArray(catalog.profiles)) throw new Error('INVALID_GATEWAY_MODELS');
    const availableModels = (catalog.profiles as JsonObject[]).filter((p) => typeof p.id === 'string' && p.enabled !== false)
      .map((p) => ({ modelId: p.id as string, name: String(p.model_name || p.name || p.id) }));
    if (!availableModels.length) throw new Error('GATEWAY_NO_MODELS');
    const selected = catalog.current_profile_id || catalog.selected_profile_id || catalog.active_profile_id;
    return { currentModelId: availableModels.find((m) => m.modelId === selected)?.modelId || availableModels[0].modelId, availableModels };
  };
  const configOptions = (models: JsonObject) => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: models.currentModelId,
    options: (models.availableModels as JsonObject[]).map((model) => ({ value: model.modelId, name: model.name })) }];
  return {
    async request(method: string, params: JsonObject): Promise<JsonObject> {
      if (method === 'initialize') return {
        protocolVersion: 1, agentInfo: { name: 'my-agent', title: 'my-agent（.10 研发编码底座）', version: '1.0.0' },
        agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true, image: false, audio: false },
          mcpCapabilities: { stdio: false, http: false, sse: false } }, authMethods: [],
      };
      // Core injects these reserved env values. Browser/ACP params cannot select another actor.
      if (context && (!context.userId || !context.conversationId || !await context.store.get('agent_bindings', `${context.userId}:my-agent`))) {
        throw new Error('CORE_USER_CONTEXT_REQUIRED');
      }
      if (method === 'session/new' || method === 'session/load') {
        const id = method === 'session/new' ? randomUUID() : params.sessionId;
        if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_ACP_SESSION');
        if (context) {
          const key = `${context.userId}:acp:${id}`;
          if (method === 'session/load') {
            const stored = await context.store.get('agent_bindings', key) as JsonObject | undefined;
            if (stored?.conversation_id !== context.conversationId) throw new Error('INVALID_ACP_SESSION');
          } else await context.store.write([{ table: 'agent_bindings', key, value: { conversation_id: context.conversationId } }]);
        }
        if (method === 'session/load') await client.history(conversation(id));
        const models = await modelState(id);
        sessions.set(id, { cwd: typeof params.cwd === 'string' ? params.cwd : '.', models, busy: false });
        return { ...(method === 'session/new' ? { sessionId: id } : {}), models, configOptions: configOptions(models) };
      }
      const id = params.sessionId;
      const session = typeof id === 'string' ? sessions.get(id) : undefined;
      if (!session || typeof id !== 'string') throw new Error('INVALID_ACP_SESSION');
      if (method === 'session/set_model' || method === 'session/set_config_option') {
        const modelId = method === 'session/set_model' ? params.modelId : params.value;
        if (method === 'session/set_config_option' && params.configId !== 'model') throw new Error('UNSUPPORTED_ACP_OPTION');
        if (!(session.models.availableModels as JsonObject[]).some((m) => m.modelId === modelId)) throw new Error('INVALID_GATEWAY_MODEL');
        await client.selectModel(conversation(id), modelId as string);
        session.models.currentModelId = modelId;
        return method === 'session/set_config_option' ? { configOptions: configOptions(session.models) } : {};
      }
      if (method === 'session/cancel') {
        session.abort?.abort();
        await client.cancel(conversation(id));
        return {};
      }
      if (method !== 'session/prompt') throw new Error('UNSUPPORTED_ACP_METHOD');
      if (session.busy) throw new Error('ACP_SESSION_BUSY');
      if (!Array.isArray(params.prompt)) throw new Error('INVALID_ACP_PROMPT');
      const text = (params.prompt as JsonObject[]).map((block) => {
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        if (block.type === 'resource_link' && typeof block.uri === 'string') return `Referenced file: ${block.uri}`;
        if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
          const resource = block.resource as JsonObject;
          if (typeof resource.text === 'string') return `${String(resource.uri || '')}\n${resource.text}`;
        }
        throw new Error('UNSUPPORTED_ACP_CONTENT');
      }).join('\n');
      if (!text.trim()) throw new Error('INVALID_ACP_PROMPT');
      session.busy = true;
      const abort = new AbortController(); session.abort = abort;
      try {
        const accepted = await client.ask(conversation(id), `AionUi requested workspace: ${session.cwd}\n\n${text}`, randomUUID());
        if (typeof accepted.request_id !== 'string') throw new Error('INVALID_GATEWAY_ACCEPTED');
        const answer = await client.waitForResult(accepted.request_id, undefined, abort.signal);
        if (context) {
          const key = `${context.userId}:${context.conversationId}`;
          await context.store.write([
            { table: 'conversations', key, value: { id: context.conversationId, gateway_conversation_id: conversation(id), agent_id: 'my-agent' } },
            { table: 'messages', key: `${key}:gateway:${accepted.request_id}`, value: { request_id: accepted.request_id, user_text: text, assistant_text: answer } },
            { table: 'sync_metadata', key: `${key}:gateway`, value: { request_id: accepted.request_id, synced_at: Date.now() } },
          ]);
        }
        await notify({ sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } } });
        return { stopReason: 'end_turn' };
      } catch (error) {
        if (abort.signal.aborted) return { stopReason: 'cancelled' };
        throw error;
      } finally { session.busy = false; session.abort = undefined; }
    },
  };
}

/** Use the official SDK framing/validation on stdin/stdout; diagnostics must stay on stderr. */
export async function runAcpStdio(client: GatewayClient, context?: AcpContext): Promise<void> {
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  );
  const connection = new AgentSideConnection((peer): Agent => {
    const agent = createAcpAgent(client, async (p) => { await peer.sessionUpdate(p as unknown as SessionNotification); }, context);
    const invoke = <T>(method: string, p: unknown): Promise<T> => agent.request(method, p as JsonObject) as Promise<T>;
    return {
      initialize: (p) => invoke<InitializeResponse>('initialize', p),
      authenticate: async () => { throw new Error('CORE_USER_CONTEXT_REQUIRED'); },
      newSession: (p) => invoke<NewSessionResponse>('session/new', p),
      loadSession: (p) => invoke<LoadSessionResponse>('session/load', p),
      prompt: (p) => invoke<PromptResponse>('session/prompt', p),
      cancel: async (p) => { await invoke('session/cancel', p); },
      unstable_setSessionModel: (p) => invoke<SetSessionModelResponse>('session/set_model', p),
      setSessionConfigOption: (p) => invoke<SetSessionConfigOptionResponse>('session/set_config_option', p),
    };
  }, stream);
  await connection.closed;
}
