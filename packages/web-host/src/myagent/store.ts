import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';

export const ENTITY_TABLES = ['conversations', 'messages', 'agent_bindings', 'user_settings', 'sync_metadata'] as const;
export type EntityTable = (typeof ENTITY_TABLES)[number];
export type StoreEntry = { table: EntityTable; key: string; value: unknown };
export type BridgeStore = {
  mode: 'postgres' | 'json';
  get: (table: EntityTable, key: string) => Promise<unknown>;
  list: (table: EntityTable, prefix?: string) => Promise<StoreEntry[]>;
  write: (entries: StoreEntry[]) => Promise<void>;
  remove: (table: EntityTable, key: string) => Promise<void>;
  close: () => Promise<void>;
};

/** PostgreSQL when explicitly configured, otherwise private atomic local JSON. */
export async function openBridgeStore(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<BridgeStore> {
  const pgConfigured = !!env.AIONUI_PG_DSN || ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'].some((key) => !!env[key]);
  if (!pgConfigured) return openJsonStore(dataDir);
  const pool = new Pool({
    ...(env.AIONUI_PG_DSN ? { connectionString: env.AIONUI_PG_DSN } : {
      host: env.PGHOST || '127.0.0.1', port: Number(env.PGPORT || 5432),
      user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE || 'aionui',
    }),
    max: 4, connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000,
  });
  // Idle connection failures must not become uncaught events or disclose a DSN.
  pool.on('error', () => undefined);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const table of ENTITY_TABLES) {
        await client.query(`CREATE TABLE IF NOT EXISTS ${tableName(table)} (
          id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      }
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
      throw new Error('AIONUI_PG_UNAVAILABLE');
    } finally { client.release(); }
  } catch {
    await pool.end();
    throw new Error('AIONUI_PG_UNAVAILABLE');
  }
  return {
    mode: 'postgres',
    async get(table, key) {
      const result = await pool.query<{ data: unknown }>(`SELECT data FROM ${tableName(table)} WHERE id = $1`, [key]);
      return result.rows[0]?.data;
    },
    async list(table, prefix = '') {
      const result = await pool.query<{ id: string; data: unknown }>(
        `SELECT id, data FROM ${tableName(table)} WHERE left(id, length($1)) = $1 ORDER BY id LIMIT 10000`, [prefix]);
      return result.rows.map((row) => ({ table, key: row.id, value: row.data }));
    },
    async write(entries) {
      const frozen = freezeEntries(entries);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const entry of frozen) {
          await client.query(`INSERT INTO ${tableName(entry.table)} (id, data) VALUES ($1, $2::jsonb)
            ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [entry.key, JSON.stringify(entry.value)]);
        }
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK');
        throw new Error('AIONUI_PG_WRITE_FAILED');
      } finally { client.release(); }
    },
    async remove(table, key) { await pool.query(`DELETE FROM ${tableName(table)} WHERE id = $1`, [key]); },
    async close() { await pool.end(); },
  };
}

function tableName(table: EntityTable): string {
  if (!ENTITY_TABLES.includes(table)) throw new Error('INVALID_BRIDGE_ENTITY');
  return `aionui_${table}`;
}

function freezeEntries(entries: StoreEntry[]): StoreEntry[] {
  for (const entry of entries) {
    tableName(entry.table);
    if (typeof entry.key !== 'string' || !entry.key || entry.key.length > 2048 || entry.key.includes('\0') || entry.value === undefined) {
      throw new Error('INVALID_BRIDGE_ENTITY');
    }
  }
  return JSON.parse(JSON.stringify(entries)) as StoreEntry[];
}

async function openJsonStore(dataDir: string): Promise<BridgeStore> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, 'my-agent-bridge.json');
  let rows = new Map<string, StoreEntry>();
  try {
    const stored = JSON.parse(await readFile(file, 'utf8')) as { version: number; rows: StoreEntry[] };
    if (stored.version !== 1 || !Array.isArray(stored.rows)) throw new Error('INVALID_BRIDGE_STORE');
    rows = new Map(freezeEntries(stored.rows).map((row) => [`${row.table}\0${row.key}`, row]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('AIONUI_LOCAL_STORE_CORRUPT');
  }
  let tail = Promise.resolve();
  const enqueue = (change: (next: Map<string, StoreEntry>) => void): Promise<void> => {
    const next = tail.then(async () => {
      const updated = new Map(rows);
      change(updated);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ version: 1, rows: [...updated.values()] }));
          await handle.sync();
        } finally { await handle.close(); }
        await rename(temporary, file);
        rows = updated;
      } finally { await unlink(temporary).catch((): void => undefined); }
    });
    tail = next.catch((): void => undefined);
    return next;
  };
  return {
    mode: 'json',
    async get(table, key) {
      tableName(table); await tail;
      const row = rows.get(`${table}\0${key}`);
      return row ? JSON.parse(JSON.stringify(row.value)) as unknown : undefined;
    },
    async list(table, prefix = '') {
      tableName(table); await tail;
      return freezeEntries([...rows.values()].filter((row) => row.table === table && row.key.startsWith(prefix)));
    },
    write(entries) {
      const frozen = freezeEntries(entries);
      return enqueue((updated) => { for (const row of frozen) updated.set(`${row.table}\0${row.key}`, row); });
    },
    remove(table, key) { tableName(table); return enqueue((updated) => { updated.delete(`${table}\0${key}`); }); },
    async close() { await tail; },
  };
}
