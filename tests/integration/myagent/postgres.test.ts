import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENTITY_TABLES, openBridgeStore } from '../../../packages/web-host/src/myagent/store';

// This suite is also run explicitly against a private real PostgreSQL cluster.
// CI without PostgreSQL can still run the local fallback and authentication suites.
describe.skipIf(!process.env.AIONUI_TEST_PG_DSN)('real PostgreSQL primary storage', () => {
  it('initializes and durably stores all five entity types across connections', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aionui-w3-pg-'));
    const env = { AIONUI_PG_DSN: process.env.AIONUI_TEST_PG_DSN };
    const key = `test:${randomUUID()}`;
    try {
      const first = await openBridgeStore(dir, env);
      expect(first.mode).toBe('postgres');
      await first.write(ENTITY_TABLES.map((table) => ({ table, key, value: { table, text: '真实数据库往返' } })));
      await first.close();
      const second = await openBridgeStore(dir, env);
      try {
        for (const table of ENTITY_TABLES) {
          expect(await second.get(table, key)).toEqual({ table, text: '真实数据库往返' });
          expect(await second.list(table, key)).toHaveLength(1);
          await second.remove(table, key);
          expect(await second.get(table, key)).toBeUndefined();
        }
      } finally { await second.close(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
