import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { applyMigrations } from '../scripts/migrations';
import { collectResearchPage, reconcileResearchRun } from '../src/research/pipeline';
import { researchSource, researchTime, eiaQuery, opts, researchFixture } from './research-helpers';

describe('stacked PR #16 / #18 forward migration', () => {
  it.each([false, true])(
    'preserves populated 0009 through 0012 with 0014 already applied=%s',
    async (early) => {
      const local = await localEnv('test', undefined, 9);
      try {
        const c = researchSource();
        const run = await collectResearchPage(
          local.env,
          c,
          eiaQuery,
          researchTime,
          opts(researchFixture('eia.synthetic.json')),
        );
        await reconcileResearchRun(local.env, c, run.run_id, researchTime, c.terms.version);
        const tables = [
          'research_runs',
          'research_pages',
          'research_observations',
          'research_retention_assessments',
        ];
        const before = await Promise.all(
          tables.map((t) => local.env.PRIVATE_DB.prepare('SELECT * FROM ' + t).all()),
        );
        if (early) {
          const name = '0014_research_assessments_append_only.sql';
          await local.env.PRIVATE_DB.exec(
            (await readFile('migrations/private/' + name, 'utf8')).replace(/^--.*$/gm, ''),
          );
          await local.env.PRIVATE_DB.prepare('INSERT INTO d1_migrations(name) VALUES (?)')
            .bind(name)
            .run();
        }
        await applyMigrations(local.env.PRIVATE_DB, 'private');
        await applyMigrations(local.env.PRIVATE_DB, 'private');
        for (const [i, t] of tables.entries())
          expect((await local.env.PRIVATE_DB.prepare('SELECT * FROM ' + t).all()).results).toEqual(
            before[i].results,
          );
        expect(
          (await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results,
        ).toEqual([]);
        await expect(
          local.env.PRIVATE_DB.prepare(
            "UPDATE research_retention_assessments SET state='active'",
          ).run(),
        ).rejects.toThrow('immutable_research_assessment');
        await expect(
          local.env.PRIVATE_DB.prepare('DELETE FROM research_retention_assessments').run(),
        ).rejects.toThrow('immutable_research_assessment');
        await expect(
          local.env.PRIVATE_DB.prepare('UPDATE research_runs SET normalized_expires_at=NULL').run(),
        ).rejects.toThrow('immutable_research_retention');
        await expect(
          local.env.PRIVATE_DB.prepare(
            "UPDATE research_observations SET record_key='changed'",
          ).run(),
        ).rejects.toThrow('immutable_research_observation');
      } finally {
        await local.mf.dispose();
      }
    },
  );
});
