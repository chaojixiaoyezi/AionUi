import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGatewayControlPayload, summarizeGatewayHealth } from '../src/myagent/diagnostics.js';
import { createMyAgentBridge, MyAgentWebService } from '../src/myagent/service.js';
import { openBridgeStore, type BridgeStore, type StoreEntry } from '../src/myagent/store.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aionui-g2-diagnostics-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function memoryStore(entries: StoreEntry[] = []) {
  const get = vi.fn(async (table: string, key: string): Promise<unknown> =>
    entries.find((entry) => entry.table === table && entry.key === key)?.value);
  const list = vi.fn(async (table: string, prefix = ''): Promise<StoreEntry[]> =>
    entries.filter((entry) => entry.table === table && entry.key.startsWith(prefix)));
  const store: Pick<BridgeStore, 'get' | 'list'> = { get, list };
  return { service: new MyAgentWebService(store), get, list };
}

describe('buildGatewayControlPayload', () => {
  it.each(['/stop', '/steer', '/new'] as const)('preserves message identity for %s', (command) => {
    expect(buildGatewayControlPayload(command, 'aionui:owner:conversation', 'stable-message')).toEqual({
      command,
      conversation_id: 'aionui:owner:conversation',
      metadata: { message_id: 'stable-message' },
    });
  });

  it('includes a nonempty steer goal without changing its text', () => {
    expect(buildGatewayControlPayload('/steer', 'conversation', 'message', '  改为先运行测试\n')).toEqual({
      command: '/steer', conversation_id: 'conversation', metadata: { message_id: 'message' }, goal: '  改为先运行测试\n',
    });
  });

  it.each([undefined, '', ' \n\t'])('omits an empty optional goal (%j)', (goal) => {
    expect(buildGatewayControlPayload('/new', 'conversation', 'message', goal)).not.toHaveProperty('goal');
  });

  it.each(['', ' ', '\n'])('rejects an empty conversation identity (%j)', (id) => {
    expect(() => buildGatewayControlPayload('/stop', id, 'message')).toThrow('INVALID_GATEWAY_CONTROL_INPUT');
  });

  it.each(['', ' ', '\n'])('rejects an empty message identity (%j)', (id) => {
    expect(() => buildGatewayControlPayload('/stop', 'conversation', id)).toThrow('INVALID_GATEWAY_CONTROL_INPUT');
  });

  it('rejects unsupported commands received from untyped callers', () => {
    const command = '/delete' as Parameters<typeof buildGatewayControlPayload>[0];
    expect(() => buildGatewayControlPayload(command, 'conversation', 'message')).toThrow('INVALID_GATEWAY_CONTROL_INPUT');
  });

  it('does not share mutable metadata between calls', () => {
    const first = buildGatewayControlPayload('/stop', 'conversation', 'message');
    (first.metadata as Record<string, unknown>).message_id = 'changed';
    expect(buildGatewayControlPayload('/stop', 'conversation', 'message').metadata).toEqual({ message_id: 'message' });
  });
});

describe('summarizeGatewayHealth', () => {
  it('projects flat Gateway health and request counters', () => {
    expect(summarizeGatewayHealth({
      ok: true, status: 'running', in_flight_model_calls: 3, pending_requests: 5, processing_requests: 2,
    })).toEqual({ ok: true, status: 'running', inFlightModelCalls: 3, pendingRequests: 5, processingRequests: 2 });
  });

  it('normalizes grouped model-call and request counters', () => {
    expect(summarizeGatewayHealth({
      ok: true, status: 'ok', model_calls: { in_flight: 4 }, requests: { pending: 6, processing: 2 },
    })).toEqual({ ok: true, status: 'ok', inFlightModelCalls: 4, pendingRequests: 6, processingRequests: 2 });
  });

  it('normalizes activity and queue counters', () => {
    expect(summarizeGatewayHealth({
      ok: false, status: 'degraded', model_call_activity: { in_flight_count: 1 }, queue: { pending: 7, processing: 3 },
    })).toEqual({ ok: false, status: 'degraded', inFlightModelCalls: 1, pendingRequests: 7, processingRequests: 3 });
  });

  it('keeps authoritative zero counters instead of falling back to stale grouped values', () => {
    expect(summarizeGatewayHealth({
      ok: true, status: 'idle', in_flight_model_calls: 0, pending_requests: 0, processing_requests: 0,
      model_calls: { in_flight: 9 }, requests: { pending: 8, processing: 7 },
    })).toEqual({ ok: true, status: 'idle', inFlightModelCalls: 0, pendingRequests: 0, processingRequests: 0 });
  });

  it('normalizes decimal integer strings', () => {
    expect(summarizeGatewayHealth({ in_flight_model_calls: ' 2 ', pending_requests: '0', processing_requests: '12' }))
      .toMatchObject({ inFlightModelCalls: 2, pendingRequests: 0, processingRequests: 12 });
  });

  it.each([undefined, null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, [], {}, 'NaN', '1.5', '-1', ''])
    ('does not expose invalid counters (%j)', (value) => {
      expect(summarizeGatewayHealth({ in_flight_model_calls: value, pending_requests: value, processing_requests: value }))
        .toMatchObject({ inFlightModelCalls: 0, pendingRequests: 0, processingRequests: 0 });
    });

  it.each([undefined, null, 1, 'true', false])('does not mistake a truthy health flag for true (%j)', (ok) => {
    expect(summarizeGatewayHealth({ ok }).ok).toBe(false);
  });

  it.each([undefined, null, '', '  ', 4, [], {}])('reports unknown for a missing or invalid status (%j)', (status) => {
    expect(summarizeGatewayHealth({ status }).status).toBe('unknown');
  });

  it('handles missing fields conservatively', () => {
    expect(summarizeGatewayHealth({})).toEqual({
      ok: false, status: 'unknown', inFlightModelCalls: 0, pendingRequests: 0, processingRequests: 0,
    });
  });

  it.each([null, [], 'invalid', 3])('tolerates malformed grouped counters (%j)', (value) => {
    expect(summarizeGatewayHealth({ model_calls: value, model_call_activity: value, requests: value, queue: value }))
      .toEqual({ ok: false, status: 'unknown', inFlightModelCalls: 0, pendingRequests: 0, processingRequests: 0 });
  });

  it('does not mutate a Gateway response', () => {
    const payload = Object.freeze({ ok: true, status: 'ok', requests: Object.freeze({ pending: 2, processing: 1 }) });
    summarizeGatewayHealth(payload);
    expect(payload).toEqual({ ok: true, status: 'ok', requests: { pending: 2, processing: 1 } });
  });
});

describe('MyAgentWebService.getConversationMessages', () => {
  it('returns only persisted messages for the exact owner and conversation', async () => {
    const messages = [{ id: 'm1', content: 'first' }, { id: 'm2', content: 'second' }];
    const { service } = memoryStore([
      { table: 'conversations', key: 'alice:chat', value: { id: 'chat' } },
      { table: 'messages', key: 'alice:chat:m1', value: messages[0] },
      { table: 'messages', key: 'alice:chat:m2', value: messages[1] },
      { table: 'messages', key: 'bob:chat:m1', value: { content: 'private' } },
      { table: 'messages', key: 'alice:chat-other:m1', value: { content: 'other conversation' } },
      { table: 'sync_metadata', key: 'alice:chat:sync', value: { request_id: 'not a message' } },
    ]);
    expect(await service.getConversationMessages('alice', 'chat')).toEqual(messages);
  });

  it('returns an empty array for an owned conversation with no persisted messages', async () => {
    const { service } = memoryStore([{ table: 'conversations', key: 'alice:empty', value: { id: 'empty' } }]);
    expect(await service.getConversationMessages('alice', 'empty')).toEqual([]);
  });

  it('rejects a missing conversation before reading any messages', async () => {
    const { service, list } = memoryStore([{ table: 'messages', key: 'alice:missing:m1', value: { content: 'orphan' } }]);
    await expect(service.getConversationMessages('alice', 'missing')).rejects.toThrow('NOT_FOUND');
    expect(list).not.toHaveBeenCalled();
  });

  it('does not reveal another user\'s conversation or messages', async () => {
    const { service, list } = memoryStore([
      { table: 'conversations', key: 'bob:private', value: { id: 'private' } },
      { table: 'messages', key: 'bob:private:m1', value: { content: 'private' } },
    ]);
    await expect(service.getConversationMessages('alice', 'private')).rejects.toThrow('NOT_FOUND');
    expect(list).not.toHaveBeenCalled();
  });

  it('keeps identical conversation IDs isolated across users', async () => {
    const { service } = memoryStore([
      { table: 'conversations', key: 'alice:shared-id', value: { id: 'shared-id' } },
      { table: 'conversations', key: 'bob:shared-id', value: { id: 'shared-id' } },
      { table: 'messages', key: 'alice:shared-id:m1', value: { content: 'alice' } },
      { table: 'messages', key: 'bob:shared-id:m1', value: { content: 'bob' } },
    ]);
    expect(await service.getConversationMessages('alice', 'shared-id')).toEqual([{ content: 'alice' }]);
    expect(await service.getConversationMessages('bob', 'shared-id')).toEqual([{ content: 'bob' }]);
  });

  it.each([null, {}, { id: 'different' }])('rejects an invalid conversation snapshot (%j)', async (value) => {
    const { service, list } = memoryStore([{ table: 'conversations', key: 'alice:chat', value }]);
    await expect(service.getConversationMessages('alice', 'chat')).rejects.toThrow('NOT_FOUND');
    expect(list).not.toHaveBeenCalled();
  });

  it.each([['', 'chat'], ['alice', '']])('rejects empty identities (%j, %j)', async (userId, id) => {
    const { service, get } = memoryStore();
    await expect(service.getConversationMessages(userId, id)).rejects.toThrow('NOT_FOUND');
    expect(get).not.toHaveBeenCalled();
  });

  it('propagates storage lookup failures rather than returning a misleading empty snapshot', async () => {
    const { service, get, list } = memoryStore();
    get.mockRejectedValueOnce(new Error('STORE_UNAVAILABLE'));
    await expect(service.getConversationMessages('alice', 'chat')).rejects.toThrow('STORE_UNAVAILABLE');
    expect(list).not.toHaveBeenCalled();
  });

  it('propagates message storage failures', async () => {
    const { service, list } = memoryStore([{ table: 'conversations', key: 'alice:chat', value: { id: 'chat' } }]);
    list.mockRejectedValueOnce(new Error('STORE_READ_FAILED'));
    await expect(service.getConversationMessages('alice', 'chat')).rejects.toThrow('STORE_READ_FAILED');
  });

  it('reads native and Gateway message snapshots after reopening the persistent store', async () => {
    const dir = await fixtureDir();
    const first = await openBridgeStore(dir, {});
    const messages = [{ id: 'native', content: 'native message' }, { request_id: 'r1', user_text: 'question', assistant_text: 'answer' }];
    await first.write([
      { table: 'conversations', key: 'alice:chat', value: { id: 'chat' } },
      ...messages.map((value, i): StoreEntry => ({ table: 'messages', key: `alice:chat:m${i}`, value })),
    ]);
    await first.close();
    const reopened = await openBridgeStore(dir, {});
    cleanup.push(() => reopened.close());
    expect(await new MyAgentWebService(reopened).getConversationMessages('alice', 'chat')).toEqual(messages);
  });

  it('exposes the helper through the existing bridge without changing its HTTP entry', async () => {
    const bridge = await createMyAgentBridge({
      backendPort: 1, dataDir: await fixtureDir(), bootstrapSecret: '', env: {},
      runtime: { command: 'bun', args: ['/trusted/adapter.ts'] },
    });
    cleanup.push(() => bridge.close());
    await bridge.store.write([
      { table: 'conversations', key: 'alice:chat', value: { id: 'chat' } },
      { table: 'messages', key: 'alice:chat:m1', value: { content: 'persisted' } },
    ]);
    const getMessages = bridge.getConversationMessages;
    expect(await getMessages('alice', 'chat')).toEqual([{ content: 'persisted' }]);
    await expect(getMessages('bob', 'chat')).rejects.toThrow('NOT_FOUND');
  });
});
