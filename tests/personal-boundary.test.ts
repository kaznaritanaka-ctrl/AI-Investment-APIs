import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
it('keeps personal authority out of public API and local NAS code out of both bundles; Cloud entrypoint is disabled', async () => {
  for (const file of ['wrangler.collector.jsonc', 'wrangler.api.jsonc']) {
    const config = JSON.parse(await readFile(file, 'utf8'));
    const built = await build({
      entryPoints: [config.main],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'browser',
      format: 'esm',
      external: ['cloudflare:workers'],
      logLevel: 'silent',
    });
    expect(Object.keys(built.metafile!.inputs).some((path) => /scripts\/personal/.test(path))).toBe(
      false,
    );
    if (file === 'wrangler.api.jsonc') {
      expect(
        Object.keys(built.metafile!.inputs).some((path) => /src\/research\/personal/.test(path)),
      ).toBe(false);
      expect(built.outputFiles[0].text).not.toContain('owner_personal_research_exception');
    } else {
      expect(Object.keys(built.metafile!.inputs)).toContain(
        'src/research/personal-cloud-scheduled.ts',
      );
      expect(config.vars.PERSONAL_MAINTENANCE_ENABLED).toBeUndefined();
      expect(config.vars.PERSONAL_INITIAL_COLLECTION_ENABLED).toBeUndefined();
      expect(config.vars.PERSONAL_CLOUD_PINS).toBeUndefined();
    }
  }
});
