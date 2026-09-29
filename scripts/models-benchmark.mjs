import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('work', { recursive: true });
await build({
  entryPoints: ['scripts/models-profile.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: 'work/models-profile.mjs',
  logLevel: 'warning',
});
const measurements = [];
for (const n of [50, 250, 1000])
  for (const padding of [0, 8 * 1024 * 1024]) {
    const r = spawnSync(
      process.execPath,
      ['--expose-gc', 'work/models-profile.mjs', String(n), String(padding)],
      { encoding: 'utf8', windowsHide: true },
    );
    if (r.status !== 0) throw new Error(r.stderr || 'profile_failed');
    measurements.push(JSON.parse(r.stdout));
  }
const report = {
  test_kind: 'synthetic_node_process_profile',
  node: process.version,
  platform: process.platform,
  measurement_scope:
    'Host process includes runtime/libraries; RSS is not a Worker isolate measurement. CPU is not billed Cloudflare CPU.',
  measurements,
};
writeFileSync('work/models-benchmark-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
