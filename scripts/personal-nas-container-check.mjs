// CI-only acceptance. Every dataset/key is synthetic and the container has no network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

assert.equal(process.platform, 'linux');
assert.notEqual(process.getuid(), 0);
await assert.rejects(writeFile('/app/must-stay-readonly', 'synthetic'), { code: 'EROFS' });
await mkdir('work/tmp', { recursive: true });
const env = {
  ...process.env,
  TEMP: resolve('work/tmp'),
  TMP: resolve('work/tmp'),
  TMPDIR: resolve('work/tmp'),
};
const run = (args) => spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 600000 });
const plan = run(['scripts/personal-nas-runner.mjs', 'plan']);
assert.equal(plan.status, 0, 'packaged CLI plan must run');
assert.equal(JSON.parse(plan.stdout).network, false);
await writeFile(
  'work/disabled.json',
  JSON.stringify({ version: 'personal-nas-runtime-v2', enabled: false }),
);
const disabled = run([
  'scripts/personal-nas-runner.mjs',
  'once',
  resolve('work/disabled.json'),
  '--allow-network',
]);
assert.equal(disabled.status, 1, 'disabled runtime must fail before admission');
assert.match(disabled.stderr, /personal_nas_failed/);
await writeFile(
  'work/vitest.personal.config.mjs',
  'export default { cacheDir: "work/vite-cache", test: { include: ["tests/**/*.test.ts"] } };',
);
const tests = run([
  'node_modules/vitest/vitest.mjs',
  'run',
  '--config=work/vitest.personal.config.mjs',
  '--configLoader=runner',
  '--cache=false',
  'tests/nas-lock.test.ts',
  'tests/personal-nas.test.ts',
  'tests/daily-nas.test.ts',
  '--maxWorkers=1',
  '--fileParallelism=false',
  '--testTimeout=120000',
  '--hookTimeout=120000',
]);
process.stdout.write(tests.stdout ?? '');
process.stderr.write(tests.stderr ?? '');
assert.equal(tests.status, 0, 'personal NAS synthetic tests must pass in the runtime container');
console.log(
  'Personal NAS container passed: nonroot, read-only code, no network, real synthetic age/Miniflare restore and kernel lease recovery; no real NAS admission.',
);
