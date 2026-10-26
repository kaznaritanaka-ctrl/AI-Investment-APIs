import { isoTime } from '../util';
import { minuteSlot } from '../run-identity';

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
// Ignore event seconds/milliseconds and use one normalized collection identity.
export function dcCollectionSlot(scheduled: string) {
  if (!isoTime(scheduled)) return null;
  const date = new Date(scheduled);
  return date.getUTCDay() === 1 && date.getUTCHours() === 18 && date.getUTCMinutes() === 17
    ? minuteSlot(scheduled)
    : null;
}
