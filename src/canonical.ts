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
