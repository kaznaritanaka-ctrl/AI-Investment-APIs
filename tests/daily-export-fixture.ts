import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dailyFixture } from './daily-helpers';
import { PersonalDailySchema } from '../src/research/personal-contract';
import {
  DailyControl,
  dailyRoot,
  dailyRunId,
  DailyManifest,
  validateDailySnapshot,
} from '../src/research/daily-protocol';
import { hash, stable } from '../src/util';
import type { DailyEnv } from '../src/research/personal-daily';
import { exportFixture } from './nas-export-fixture';
import { parsePublicGpu, gpuRecordFingerprint } from '../src/research/public-gpu-html';
import { dailySeriesDefinition } from '../src/research/daily-series';
import {
  HIGHRESO_POST_TERMS_URL,
  HIGHRESO_DOMESTIC_TERMS_BOUNDARY,
} from '../src/research/public-gpu-contract';

// Scale tests run actual SQLite migrations/queries/triggers and actual snapshot
// hashing/validation. R2 is an in-memory conditional-object double, not Cloud CPU/IAM.
export function exportMemory(upTo = 16) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync('migrations/private')
    .filter((f) => /^\d+.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= upTo)
    .sort())
    sqlite.exec(readFileSync('migrations/private/' + f, 'utf8'));
  const metrics = { queries: 0, maxBatch: 0 };
  const prepare = (sql: string) => {
    let args: any[] = [];
    const s = {
      bind(...v: any[]) {
        args = v;
        return s;
      },
      async all() {
        metrics.queries++;
        return { results: sqlite.prepare(sql).all(...args), success: true, meta: {} };
      },
      async first(key?: string) {
        const rows = await s.all();
        const r = rows.results[0];
        return r ? (key ? r[key] : r) : null;
      },
      async run() {
        metrics.queries++;
        const r = sqlite.prepare(sql).run(...args);
        return { success: true, results: [], meta: { changes: Number(r.changes) } };
      },
    };
    return s;
  };
  const db = {
    prepare,
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
    async batch(statements: any[]) {
      metrics.maxBatch = Math.max(metrics.maxBatch, statements.length);
      if (statements.length > 20) throw new Error('synthetic_batch_bound');
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
  const origin = new MemoryObjects(),
    out = new MemoryObjects();
  const pin = exportFixture();
  const env: DailyEnv = {
    PRIVATE_DB: db,
    EVIDENCE: origin as unknown as R2Bucket,
    ENVIRONMENT: 'test',
  };
  const base = {
    EVIDENCE: env.EVIDENCE,
    NAS_EXPORT: out as unknown as R2Bucket,
    PERSONAL_EXPORT_PINS: stable(pin),
  };
  return { sqlite, metrics, origin, out, env, base, pin, close: () => sqlite.close() };
}
export class MemoryObjects {
  objects = new Map<
    string,
    { body: Uint8Array; etag: string; customMetadata: Record<string, string> }
  >();
  counter = 0;
  calls = 0;
  maxPut = 0;
  maxDelete = 0;
  fault: ((op: string, key: string) => void) | undefined;
  private sorted: string[] | null = null;
  async get(key: string) {
    this.calls++;
    this.fault?.('get', key);
    const o = this.objects.get(key);
    return o
      ? {
          key,
          etag: o.etag,
          size: o.body.length,
          customMetadata: o.customMetadata,
          text: async () => new TextDecoder().decode(o.body),
          json: async () => JSON.parse(new TextDecoder().decode(o.body)),
          arrayBuffer: async () => o.body.slice().buffer,
        }
      : null;
  }
  async head(key: string) {
    return this.get(key);
  }
  async put(key: string, input: string | Uint8Array | ArrayBuffer, options: any = {}) {
    this.calls++;
    this.fault?.('put', key);
    const old = this.objects.get(key),
      c = options.onlyIf;
    if ((c?.etagMatches && old?.etag !== c.etagMatches) || (c?.etagDoesNotMatch === '*' && old))
      return null;
    const body =
      typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input).slice();
    this.maxPut = Math.max(this.maxPut, body.length);
    const etag = String(++this.counter);
    this.objects.set(key, { body, etag, customMetadata: options.customMetadata ?? {} });
    if (!old) this.sorted = null;
    return { key, etag, size: body.length };
  }
  async delete(input: string | string[]) {
    const keys = Array.isArray(input) ? input : [input];
    this.maxDelete = Math.max(this.maxDelete, keys.length);
    for (const key of keys) {
      this.fault?.('delete', key);
      this.objects.delete(key);
    }
    this.sorted = null;
    this.calls++;
  }
  async list(o: { prefix: string; cursor?: string; limit: number }) {
    this.calls++;
    if (!this.sorted) this.sorted = [...this.objects.keys()].sort();
    const keys: string[] = [];
    let more = false;
    for (const k of this.sorted) {
      if (k <= (o.cursor ?? '') || !k.startsWith(o.prefix)) continue;
      if (keys.length === o.limit) {
        more = true;
        break;
      }
      keys.push(k);
    }
    return {
      objects: keys.map((key) => ({ key, customMetadata: this.objects.get(key)!.customMetadata })),
      truncated: more,
      ...(more ? { cursor: keys.at(-1) } : {}),
    };
  }
  async json(key: string) {
    return (await this.get(key))?.json() ?? null;
  }
}
export const scaleAt = (n: number) =>
  new Date(Date.parse('2026-11-02T01:00:00.000Z') + n * 86400000).toISOString();
export async function seedExportHistory(
  m: ReturnType<typeof exportMemory>,
  source: 'highreso_public' | 'rebro_public',
  n: number,
  offset = 0,
  retentionDays = 90,
) {
  const f = await dailyFixture(source),
    c = structuredClone(f.c);
  c.decision.acquisition_from = scaleAt(0);
  c.decision.acquisition_until = '2040-01-01T00:00:00.000Z';
  c.decision.analysis_until = c.decision.acquisition_until;
  c.decision.terms.review_after = c.decision.acquisition_until;
  c.decision.exception_id = 'synthetic-series-' + Math.floor(offset / 3660);
  if (source === 'highreso_public') {
    c.decision.terms.applicability = 'highreso_domestic_post_20261101';
    c.decision.terms.monitored_url = HIGHRESO_POST_TERMS_URL;
    c.decision.terms.transition = {
      effective_from: HIGHRESO_DOMESTIC_TERMS_BOUNDARY,
      previous_terms_sha256: 'e'.repeat(64),
      new_document_review_ref: 'SYNTHETIC ONLY',
      public_page_applicability_ref: 'SYNTHETIC ONLY',
      private_acquisition_storage_analysis_basis_ref: 'SYNTHETIC ONLY',
    };
  }
  c.decision.retention.backup.retention_days = retentionDays;
  c.decision.retention.backup.max_copies = retentionDays + 1;
  c.decision.retention.backup_recoverability_days = retentionDays;
  const contract = PersonalDailySchema.parse(c),
    h = await hash(stable(contract));
  m.sqlite
    .prepare('INSERT OR IGNORE INTO personal_daily_contracts VALUES (?,?,?)')
    .run(h, source, stable(contract));
  await m.origin.put(
    dailyRoot(source) + 'authority/' + h + '.json',
    stable(
      DailyControl.parse({
        version: 1,
        contract_hash: h,
        sequence: 0,
        reviewed_at: scaleAt(0),
        storage: 'continuing',
        storage_ends_at: null,
        collection_stopped: true,
        review_after: c.decision.terms.review_after,
        analysis_until: c.decision.analysis_until,
        approval_ref: 'SYNTHETIC ONLY',
      }),
    ),
  );
  const ids: string[] = [];
  const template = (
    await parsePublicGpu(
      c.config,
      readFileSync(
        'tests/fixtures/research/' +
          (source === 'highreso_public' ? 'highreso' : 'rebro') +
          '.synthetic.html',
        'utf8',
      ),
      scaleAt(0),
      true,
    )
  ).records[0];
  const series = await hash(stable(dailySeriesDefinition(contract)));
  let previous: string | null = null;
  for (let i = offset; i < offset + n; i++) {
    const at = scaleAt(i),
      run = await dailyRunId(source, at.slice(0, 10), 'synthetic');
    ids.push(run);
    const record = structuredClone(template);
    record.offer.observed_at = at;
    const fingerprint = await gpuRecordFingerprint(record),
      observation = await hash(stable([run, record.record_key, fingerprint]));
    const row = {
      observation_id: observation,
      run_id: run,
      record_key: record.record_key,
      record_hash: fingerprint,
      observed_at: at,
      recorded_at: at,
      previous_observation_id: previous,
      change_kind: previous ? 'reobserved' : 'first_seen',
      domain_json: stable(record),
    };
    m.sqlite
      .prepare(
        "INSERT INTO personal_daily_runs(run_id,source_id,day,synthetic,contract_hash,started_at,observed_at,state,record_count,evidence_hash,evidence_expires_at) VALUES (?,?,?,1,?,?,?,'partial',1,?,?)",
      )
      .run(run, source, at.slice(0, 10), h, at, at, 'a'.repeat(64), scaleAt(i + 7));
    m.sqlite
      .prepare('INSERT INTO personal_daily_observations VALUES (?,?,?,?,?,?,?,?,?)')
      .run(...Object.values(row));
    if (i % 2 === 1) {
      const coverage = {
        recorded_at: at,
        series_id: series,
        previous_complete_run_id: ids.at(-2) ?? null,
        seen_count: 1,
        not_seen_count: 0,
        event_count: 1,
        selection: null,
      };
      const plan = await hash(
        stable({
          version: 'daily-plan-v2',
          contract_hash: h,
          run_id: run,
          payload_hash: 'a'.repeat(64),
          recorded_at: at,
          coverage,
          records: [row],
        }),
      );
      m.sqlite
        .prepare('INSERT INTO personal_daily_coverage VALUES (?,?,?,?)')
        .run(run, series, plan, stable(coverage));
    }
    m.sqlite.prepare("UPDATE personal_daily_runs SET state='complete' WHERE run_id=?").run(run);
    previous = observation;
  }
  await seedCatalog(m, source, scaleAt(offset + n));
  return { contract, h, ids };
}
export async function seedCatalog(m: ReturnType<typeof exportMemory>, source: string, at: string) {
  const rows = m.sqlite
    .prepare(
      'SELECT ordinal,run_id,state,contract_hash,reason FROM personal_daily_runs WHERE source_id=? ORDER BY ordinal',
    )
    .all(source) as any[];
  const pages = [...new Set(rows.map((r) => Math.floor((r.ordinal - 1) / 32)))];
  for (const p of pages)
    await m.origin.put(
      dailyRoot(source) + 'catalog/' + p + '.json',
      stable(rows.filter((r) => Math.floor((r.ordinal - 1) / 32) === p)),
    );
  await m.origin.put(
    dailyRoot(source) + 'catalog.json',
    stable({
      version: 1,
      source_id: source,
      max_ordinal: rows.at(-1)?.ordinal ?? 0,
      pages,
      latest_run_id: rows.filter((r) => r.state === 'complete').at(-1)?.run_id ?? null,
      checked_at: at,
    }),
  );
}
export async function exportedSnapshot(objects: MemoryObjects, source: string, run: string) {
  const manifest = DailyManifest.parse(
    await objects.json(dailyRoot(source) + 'runs/' + run + '.json'),
  );
  const chunks = await Promise.all(
    manifest.chunks.map(async (p) => {
      const o = await objects.get(p.key);
      if (!o || o.size !== p.bytes) throw new Error('synthetic_missing_part');
      const b = new Uint8Array(await o.arrayBuffer());
      if ((await hashBytes(b)) !== p.sha256) throw new Error('synthetic_part_hash');
      return b;
    }),
  );
  const all = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of chunks) {
    all.set(b, offset);
    offset += b.length;
  }
  if ((await hashBytes(all)) !== manifest.snapshot_hash) throw new Error('synthetic_snapshot_hash');
  return {
    manifest,
    snapshot: await validateDailySnapshot(JSON.parse(new TextDecoder().decode(all))),
  };
}
import { hashBytes } from '../src/research/personal-daily';
