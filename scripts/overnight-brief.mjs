import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const stop = () => {
  console.error('overnight_input_invalid_or_unavailable');
  process.exit(2);
};
process.on('uncaughtException', stop);
process.on('unhandledRejection', stop);
// Input is an existing operations:check JSON and optional local repair receipts.
// No production connections, market-data fetches, LLM calls or notifications.
const args = process.argv.slice(2);
if (!args.length) {
  console.log(
    'overnight:brief --status <operations.json> [--repair <repair-result.json>] [--synthetic]',
  );
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--synthetic') continue;
  if (!['--status', '--repair'].includes(args[i]) || !args[++i] || args[i].startsWith('--'))
    throw new Error('invalid_brief_argument');
}
const value = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
if (!value('--status')) throw new Error('status_file_required');
const input = JSON.parse(readFileSync(resolve(value('--status')), 'utf8'));
if (
  !input.overnight ||
  input.overnight.schema_version !== 1 ||
  !Array.isArray(input.overnight.sources)
)
  throw new Error('overnight_report_required');
mkdirSync('work/overnight-tool', { recursive: true });
await build({
  entryPoints: ['src/overnight.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'work/overnight-tool/index.mjs',
  logLevel: 'silent',
});
const { attachRepairResult } = await import(
  pathToFileURL(resolve('work/overnight-tool/index.mjs'))
);
const repair = value('--repair')
  ? JSON.parse(readFileSync(resolve(value('--repair')), 'utf8'))
  : null;
const now = new Date().toISOString();
const result = {
  ...input.overnight,
  briefing_generated_at: now,
  synthetic: args.includes('--synthetic'),
  notification_delivery: 'not_attempted',
  sources: input.overnight.sources.map((s) =>
    repair && s.source_id === repair.source_id
      ? attachRepairResult(s, repair, now, args.includes('--synthetic'))
      : s,
  ),
};
console.log(JSON.stringify(result, null, 2));
