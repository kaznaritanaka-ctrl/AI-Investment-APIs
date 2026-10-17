import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
it('keeps personal authority and local operation code out of both production bundles', async () => {
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
    expect(
      Object.keys(built.metafile!.inputs).some((path) =>
        /src\/research\/personal|scripts\/personal/.test(path),
      ),
    ).toBe(false);
    expect(built.outputFiles[0].text).not.toContain('owner_personal_research_exception');
  }
});
