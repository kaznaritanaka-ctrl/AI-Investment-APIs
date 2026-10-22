import { isoTime } from '../util';

export const dcSourceIds = [
  'dc_softbank',
  'dc_kddi',
  'dc_sakura',
  'dc_highreso',
  'dc_gmo_internet',
  'dc_mc_digitalrealty',
  'dc_edgeconnex',
  'dc_nttdata',
] as const;
export const isDCSource = (id: string) => dcSourceIds.some((source) => source === id);

// Only the existing daily cron's Monday 18:17 UTC slot. No continuations or catch-up days.
export function dcCollectionSlot(scheduled: string) {
  if (!isoTime(scheduled)) return null;
  const date = new Date(scheduled);
  return date.getUTCDay() === 1 && scheduled.slice(11) === '18:17:00.000Z' ? scheduled : null;
}
