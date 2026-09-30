import Decimal from 'decimal.js';
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
export function decimal(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 100 ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(value)
  )
    throw new Error('invalid_decimal');
  const n = new D(value);
  if (!n.isFinite() || n.isNegative() || n.gt('1e30') || (n.gt(0) && n.lt('1e-30')))
    throw new Error('decimal_out_of_bounds');
  return n.toFixed();
}
export function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stable(obj[k]))
      .join(',') +
    '}'
  );
}
export async function hash(value: string): Promise<string> {
  return hashBytes(new TextEncoder().encode(value));
}
export async function hashBytes(value: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export function isoDate(s: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s
  );
}
export function isoTime(s: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString() === s.replace(/Z$/, s.includes('.') ? 'Z' : '.000Z')
  );
}
export async function batches(db: D1Database, statements: D1PreparedStatement[]) {
  const metrics = { rows_read: 0, rows_written: 0, sql_statements: statements.length };
  for (let i = 0; i < statements.length; i += 20)
    for (const r of await db.batch(statements.slice(i, i + 20))) {
      metrics.rows_read += r.meta.rows_read ?? 0;
      metrics.rows_written += r.meta.rows_written ?? 0;
    }
  return metrics;
}
export const errorCode = (e: unknown) =>
  e instanceof Error && /^[a-z][a-z0-9_:-]{0,100}$/.test(e.message)
    ? e.message
    : 'operation_failed';
