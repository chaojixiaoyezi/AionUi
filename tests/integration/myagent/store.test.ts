import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENTITY_TABLES, openBridgeStore } from '../../../packages/web-host/src/myagent/store';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aionui-w3-store-')); dirs.push(dir); return dir;
}

describe('private JSON fallback', () => {
  it.each(ENTITY_TABLES)('persists %s across store restarts without PostgreSQL configuration', async (table) => {
    const dir = await fixtureDir();
    const first = await openBridgeStore(dir, {});
    await first.write([{ table, key: 'test-owner:test-id', value: { text: 'persisted', sequence: 1 } }]);
    await first.close();
    const second = await openBridgeStore(dir, {});
    expect(await second.get(table, 'test-owner:test-id')).toEqual({ text: 'persisted', sequence: 1 });
    await second.close();
  });
  it('serializes concurrent writes without dropping either update and keeps the file private', async () => {
    const dir = await fixtureDir(); const store = await openBridgeStore(dir, {});
    await Promise.all(['one', 'two'].map((key) => store.write([{ table: 'messages', key, value: key }])));
    expect((await store.list('messages')).map((row) => row.key).sort()).toEqual(['one', 'two']);
    expect((await stat(join(dir, 'my-agent-bridge.json'))).mode & 0o077).toBe(0);
    await store.close();
  });
  it('removes persisted entities rather than resurrecting them after restart', async () => {
    const dir = await fixtureDir(); const store = await openBridgeStore(dir, {});
    await store.write([{ table: 'conversations', key: 'gone', value: { id: 'gone' } }]);
    await store.remove('conversations', 'gone'); await store.close();
    const reopened = await openBridgeStore(dir, {});
    expect(await reopened.list('conversations')).toEqual([]); await reopened.close();
  });
  it('does not silently fall back to JSON when PostgreSQL was explicitly configured but unavailable', async () => {
    const dir = await fixtureDir();
    await expect(openBridgeStore(dir, { AIONUI_PG_DSN: 'postgres://invalid-fixture@127.0.0.1:1/aionui?connect_timeout=1' })).rejects.toThrow('AIONUI_PG_UNAVAILABLE');
  });
});
