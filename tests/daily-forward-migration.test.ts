import { it, expect } from 'vitest';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { applyMigrations } from '../scripts/migrations';
import { dailyFixture, heartbeat, receiptSecret } from './daily-helpers';
import { parsePublicGpu, gpuRecordFingerprint } from '../src/research/public-gpu-html';
import { rentalHtml } from './daily-series-helpers';
import {
  collectDaily,
  exportDailyHistory,
  dailyJSON,
  type DailyEnv,
} from '../src/research/personal-daily';
import {
  dailyRunId,
  dailyRoot,
  DailyManifest,
  validateDailySnapshot,
} from '../src/research/daily-protocol';
import { hash, stable } from '../src/util';
import { gpuFetcher, gpuTime } from './public-gpu-helpers';
it('forward 0015 preserves populated 0013/0014 rows, hashes, deadlines and triggers; legacy v1 export still validates', async () => {
  const mf = new Miniflare({
    cf: false,
    modules: true,
    script: 'export default {fetch(){return new Response(null)}}',
    compatibilityDate: '2026-07-30',
    log: new Log(LogLevel.ERROR),
    d1Databases: ['PRIVATE_DB'],
    r2Buckets: ['EVIDENCE'],
  });
  try {
    const db = (await mf.getD1Database('PRIVATE_DB')) as unknown as D1Database,
      bucket = (await mf.getR2Bucket('EVIDENCE')) as unknown as R2Bucket;
    await applyMigrations(db, 'private', 14);
    const f = await dailyFixture('highreso_public'),
      run = await dailyRunId('highreso_public', '2026-10-18', 'synthetic'),
      page = await parsePublicGpu(f.c.config, rentalHtml(1), gpuTime, true),
      payload = await hash('synthetic legacy HTML digest');
    await db
      .prepare('INSERT INTO personal_daily_contracts VALUES (?,?,?)')
      .bind(f.pin.contract_hash, 'highreso_public', stable(f.c))
      .run();
    await db
      .prepare(
        "INSERT INTO personal_daily_runs(run_id,source_id,day,synthetic,contract_hash,started_at,observed_at,state,record_count,evidence_hash,evidence_expires_at)VALUES (?,?,?,1,?,?,?,'complete',?,?,?)",
      )
      .bind(
        run,
        'highreso_public',
        '2026-10-18',
        f.pin.contract_hash,
        gpuTime,
        gpuTime,
        page.records.length,
        payload,
        '2026-10-25T01:00:00.000Z',
      )
      .run();
    for (const r of page.records) {
      const fingerprint = await gpuRecordFingerprint(r);
      await db
        .prepare('INSERT INTO personal_daily_observations VALUES (?,?,?,?,?,?,NULL,?,?)')
        .bind(
          await hash(stable([run, r.record_key, fingerprint])),
          run,
          r.record_key,
          fingerprint,
          gpuTime,
          gpuTime,
          'first_seen',
          stable(r),
        )
        .run();
    }
    const tables = [
        'personal_daily_contracts',
        'personal_daily_runs',
        'personal_daily_observations',
      ],
      before = await Promise.all(
        tables.map((t) => db.prepare('SELECT * FROM ' + t + ' ORDER BY 1').all()),
      );
    await applyMigrations(db, 'private');
    await applyMigrations(db, 'private');
    for (const [i, t] of tables.entries())
      expect((await db.prepare('SELECT * FROM ' + t + ' ORDER BY 1').all()).results).toEqual(
        before[i].results,
      );
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    await expect(
      db.prepare("UPDATE personal_daily_observations SET domain_json='{}'").run(),
    ).rejects.toThrow('immutable');
    await expect(db.prepare('DELETE FROM personal_daily_observations').run()).rejects.toThrow(
      'retention',
    );
    const env: DailyEnv = {
      PRIVATE_DB: db,
      EVIDENCE: bucket,
      NAS_HEALTH: bucket,
      NAS_RECEIPT_SECRET: receiptSecret,
      ENVIRONMENT: 'test',
    };
    await bucket.put(
      dailyRoot('highreso_public') + 'authority/' + f.pin.contract_hash + '.json',
      stable({
        version: 1,
        contract_hash: f.pin.contract_hash,
        sequence: 0,
        reviewed_at: f.c.decision.approved_at,
        storage: 'continuing',
        storage_ends_at: null,
        collection_stopped: false,
        review_after: f.c.decision.terms.review_after,
        analysis_until: f.c.decision.analysis_until,
        approval_ref: f.c.daily.approval_ref,
      }),
    );
    await exportDailyHistory(env, 'highreso_public', gpuTime);
    const manifest = DailyManifest.parse(
      await dailyJSON(bucket, dailyRoot('highreso_public') + 'runs/' + run + '.json'),
    );
    const parts = await Promise.all(
      manifest.chunks.map(
        async (p) => new Uint8Array(await (await bucket.get(p.key))!.arrayBuffer()),
      ),
    );
    expect(await validateDailySnapshot(JSON.parse(Buffer.concat(parts).toString()))).toMatchObject({
      version: 'daily-history-v1',
      contract_hash: f.pin.contract_hash,
    });
    const at = '2026-10-19T01:00:00.000Z';
    await heartbeat(env, 'highreso_public', at);
    expect(
      (
        await collectDaily(env, f.c, f.pin, {
          now: () => at,
          allow_network: true,
          fetcher: gpuFetcher('highreso_public', rentalHtml(1)),
        })
      ).state,
    ).toBe('complete');
    expect(
      (
        await db
          .prepare('SELECT change_kind FROM personal_daily_observations WHERE run_id!=?')
          .bind(run)
          .all()
      ).results.map((r) => r.change_kind),
    ).toEqual(['reobserved', 'reobserved']);
    expect(
      (
        await db
          .prepare(
            'SELECT * FROM personal_daily_observations WHERE run_id=? ORDER BY observation_id',
          )
          .bind(run)
          .all()
      ).results,
    ).toEqual(before[2].results);
  } finally {
    await mf.dispose();
  }
}, 120000);
