import { build } from 'esbuild';
const result = await build({
  entryPoints: ['scripts/research-config-adopt.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { main, usage } = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
);

try {
  await main();
} catch (error) {
  // Never forward config/schema/CLI errors that may contain input bodies.
  const message = error instanceof Error ? error.message : '';
  console.error(
    message === usage ||
      /^(?:research_|adoption_|invalid_adoption_|unsupported_adoption_)[a-z_]+$/.test(message)
      ? message
      : 'adoption_failed',
  );
  process.exitCode = 1;
}
