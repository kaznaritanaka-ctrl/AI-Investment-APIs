import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { applyMigrations } from '../scripts/migrations';
import type { CollectorEnv } from '../src/schema';

// Executes real SQLite migrations and SQL without sockets. This local adapter
// does not replace the separate workerd/D1/R2 runtime tests.
function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const prepare = (sql: string, values: SQLInputValue[] = []): D1PreparedStatement => {
    const statement = () => sqlite.prepare(sql);
    return {
      bind: (...args: SQLInputValue[]) => prepare(sql, args),
      first: async (column?: string) => {
        const row = statement().get(...values);
        return row ? (column ? row[column] : { ...row }) : null;
      },
      all: async () => ({
        success: true,
        results: statement()
          .all(...values)
          .map((row) => ({ ...row })),
        meta: {},
      }),
      run: async () => {
        const result = statement().run(...values);
        return {
          success: true,
          results: [],
          meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
        };
      },
      raw: async () =>
        statement()
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
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, close: () => sqlite.close() };
}

export async function effectstoryOfflineEnv() {
  const privateDB = sqliteD1();
  const publicDB = sqliteD1();
  try {
    await applyMigrations(privateDB.db, 'private');
    await applyMigrations(publicDB.db, 'public');
  } catch (error) {
    privateDB.close();
    publicDB.close();
    throw error;
  }

  const objects = new Map<string, { body: string; metadata: Record<string, string> }>();
  const evidence = {
    put: async (
      key: string,
      body: string | ArrayBuffer | ArrayBufferView,
      options?: R2PutOptions,
    ) => {
      if (
        options?.onlyIf &&
        'etagDoesNotMatch' in options.onlyIf &&
        options.onlyIf.etagDoesNotMatch === '*' &&
        objects.has(key)
      )
        return null;
      const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
      objects.set(key, { body: text, metadata: options?.customMetadata ?? {} });
      return { key };
    },
    get: async (key: string) => {
      const value = objects.get(key);
      return value
        ? {
            key,
            text: async () => value.body,
            json: async () => JSON.parse(value.body),
            customMetadata: value.metadata,
          }
        : null;
    },
    head: async (key: string) => {
      const value = objects.get(key);
      return value ? { key, customMetadata: value.metadata } : null;
    },
    delete: async (keys: string | string[]) => {
      for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key);
    },
    list: async (options?: R2ListOptions) => {
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(options?.prefix ?? ''))
        .sort();
      const offset = options?.cursor ? Number(options.cursor) : 0;
      const limit = options?.limit ?? 1000;
      const page = keys.slice(offset, offset + limit);
      const truncated = offset + limit < keys.length;
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        ...(truncated ? { cursor: String(offset + limit) } : {}),
        delimitedPrefixes: [],
      };
    },
  } as unknown as R2Bucket;
  const env: CollectorEnv = {
    PRIVATE_DB: privateDB.db,
    PUBLIC_DB: publicDB.db,
    EVIDENCE: evidence,
    ENVIRONMENT: 'test',
    AGENT_ENABLED: 'false',
    COLLECTION_CRON: '17 18 * * *',
  };
  return {
    env,
    objects,
    dispose: async () => {
      privateDB.close();
      publicDB.close();
    },
  };
}
