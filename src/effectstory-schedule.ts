// Four existing continuation events precede the 18:17 Models/PoC intake.
// This expression anchors identity only; it is not an additional Cron trigger.
export const EFFECTSTORY_COLLECTION_CRON = '0 18 * * *';
export function effectstoryScheduleReady(collectionCron: unknown, resumeCron: unknown) {
  return collectionCron === '17 18 * * *' && resumeCron === '*/5 18-23 * * *';
}
export function effectstoryTurn(scheduled: string) {
  const date = new Date(scheduled);
  if (date.getUTCHours() !== 18) return null;
  switch (date.getUTCMinutes()) {
    case 0:
      return 'intake';
    case 5:
    case 10:
      return 'resume';
    case 15:
      return 'retention';
    default:
      return null;
  }
}
