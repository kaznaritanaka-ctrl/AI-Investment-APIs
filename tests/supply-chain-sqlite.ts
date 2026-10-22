import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { applyMigrations } from '../scripts/migrations';

// Socket-free SQLite D1 substitute. It executes the actual migration and query SQL;
// Miniflare runtime tests remain separate because this sandbox forbids local listeners.
function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const prepare = (sql: string, values: SQLInputValue[] = []): D1PreparedStatement => {
    const execute = () => sqlite.prepare(sql);
    return {
      bind: (...args: SQLInputValue[]) => prepare(sql, args),
      first: async (column?: string) => {
        const row = execute().get(...values);
        return row ? (column ? row[column] : { ...row }) : null;
      },
      all: async () => ({
        success: true,
        results: execute()
          .all(...values)
          .map((row) => ({ ...row })),
        meta: {},
      }),
      run: async () => {
        const result = execute().run(...values);
        return {
          success: true,
          results: [],
          meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
        };
      },
      raw: async () =>
        execute()
          .all(...values)
          .map((row) => Object.values(row)),
    } as unknown as D1PreparedStatement;
  };
  const db = {
    prepare,
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    batch: async (statements: D1PreparedStatement[]) => {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, dispose: () => sqlite.close() };
}
export async function supplyChainSQLite(through = Infinity) {
  const publicDB = sqliteD1(),
    privateDB = sqliteD1();
  await applyMigrations(publicDB.db, 'public', through);
  await applyMigrations(privateDB.db, 'private', through);
  const objects = new Map<string, { body: string; metadata: Record<string, string> }>();
  const env = {
    PUBLIC_DB: publicDB.db,
    PRIVATE_DB: privateDB.db,
    EVIDENCE: {
      put: async (
        key: string,
        body: string | ArrayBuffer | ArrayBufferView,
        options?: R2PutOptions,
      ) => {
        const text =
          typeof body === 'string' ? body : new TextDecoder().decode(body as ArrayBuffer);
        objects.set(key, { body: text, metadata: options?.customMetadata ?? {} });
        return { key };
      },
      get: async (key: string) => {
        const value = objects.get(key);
        return value ? { key, text: async () => value.body, customMetadata: value.metadata } : null;
      },
      head: async (key: string) => {
        const value = objects.get(key);
        return value ? { key, customMetadata: value.metadata } : null;
      },
      delete: async (keys: string | string[]) => {
        for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key);
      },
    } as unknown as R2Bucket,
    ENVIRONMENT: 'test' as const,
    AGENT_ENABLED: 'false',
  };
  return {
    env,
    objects,
    mf: {
      dispose: async () => {
        publicDB.dispose();
        privateDB.dispose();
      },
    },
  };
}
