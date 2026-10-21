import { dailyCatalogPage, type DailyCatalog } from './daily-protocol';
import type { z } from 'zod';

// Shared by the real NAS consumer and scale tests. Freeze the upper ordinal
// across cycles so daily appends cannot postpone a full inventory indefinitely.
export function dailyInventoryPage(
  head: z.infer<typeof DailyCatalog>,
  cursor: number,
  ceiling: number,
) {
  return head.pages.find((p) => p >= Math.floor(cursor / 32)) ?? Math.floor(ceiling / 32);
}
export function dailyInventorySlice(input: unknown, page: number, cursor: number, ceiling: number) {
  const all = dailyCatalogPage(input, page);
  const items = all.filter((i) => i.ordinal > cursor && i.ordinal <= ceiling).slice(0, 19);
  const last = items.at(-1)?.ordinal ?? cursor;
  return {
    items,
    cursor: all.some((i) => i.ordinal > last && i.ordinal <= ceiling) ? last : (page + 1) * 32,
  };
}
