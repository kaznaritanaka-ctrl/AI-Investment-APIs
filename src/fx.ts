import { D, isoDate } from './util';
import type { AIPrice, Observation, FXRate } from './schema';
function easter(year: number): string {
  const a = year % 19,
    b = Math.floor(year / 100),
    c = year % 100,
    d = Math.floor(b / 4),
    e = b % 4,
    f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4),
    k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31),
    day = ((h + l - 7 * m + 114) % 31) + 1;
  return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}
const shift = (date: string, days: number) =>
  new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
export function targetClosed(date: string): boolean {
  if (!isoDate(date)) throw new Error('invalid_date');
  const day = new Date(date).getUTCDay(),
    md = date.slice(5),
    es = easter(Number(date.slice(0, 4)));
  return (
    [0, 6].includes(day) ||
    ['01-01', '05-01', '12-25', '12-26'].includes(md) ||
    date === shift(es, -2) ||
    date === shift(es, 1)
  );
}
export function berlinDate(now: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
}
export function expectedFXDate(now: string): string {
  let date = berlinDate(now);
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(now)),
  );
  if (hour < 17) date = shift(date, -1);
  while (targetClosed(date)) date = shift(date, -1);
  return date;
}
export function freshness(observed: string, date: string | null, now: string, dataset: string) {
  const collectionLate = Date.parse(now) - Date.parse(observed) > 36 * 3600000;
  const fxLate = dataset === 'fx' && !!date && date < expectedFXDate(now);
  const stale = collectionLate || fxLate;
  return {
    stale,
    stale_reason: collectionLate
      ? 'collection_overdue'
      : fxLate
        ? 'expected_reference_date_missing'
        : null,
    fx_reference:
      dataset === 'fx' && date
        ? {
            fx_source_date: date,
            fx_observed_at: observed,
            fx_carried_forward: date < berlinDate(now),
            fx_age: Math.max(
              0,
              Math.floor((Date.parse(berlinDate(now)) - Date.parse(date)) / 86400000),
            ),
            calendar_closed: targetClosed(berlinDate(now)),
          }
        : null,
  };
}
export function crossRate(base: Observation, quote: Observation, asOf: string): string {
  if (base.dataset !== 'fx' || quote.dataset !== 'fx' || base.source_date !== quote.source_date)
    throw new Error('incompatible_fx_inputs');
  if ([base, quote].some((o) => o.observed_at > asOf || o.recorded_at > asOf))
    throw new Error('future_information');
  const b = base.domain as FXRate,
    q = quote.domain as FXRate;
  if (b.base_currency !== q.base_currency || new D(b.rate_decimal).lte(0))
    throw new Error('invalid_fx_direction');
  return new D(q.rate_decimal).div(b.rate_decimal).toDecimalPlaces(18).toFixed();
}
export function fixedTokenCost(
  price: AIPrice,
  inputTokens: string,
  outputTokens: string,
): { amount_decimal: string; assumptions: string } {
  if (price.pricing_scope !== 'provider_catalog' || price.context_pricing_tiers !== null)
    throw new Error('incompatible_price_conditions');
  if (!/^\d+$/.test(inputTokens) || !/^\d+$/.test(outputTokens))
    throw new Error('invalid_token_count');
  const input = price.price_components.find((c) => c.component_type === 'input'),
    output = price.price_components.find((c) => c.component_type === 'output');
  if (!input || !output || input.amount_decimal === null || output.amount_decimal === null)
    throw new Error('price_unknown');
  if ([input, output].some((c) => c.tier_conditions !== null || c.unit === 'request'))
    throw new Error('incompatible_price_conditions');
  const cost = (c: typeof input, n: string) =>
    new D(c.amount_decimal!).mul(n).div(c.unit === 'million_tokens' ? 1000000 : 1);
  return {
    amount_decimal: cost(input, inputTokens).plus(cost(output, outputTokens)).toFixed(),
    assumptions:
      'fixed-tokens-v1; same provider observation; excludes cache, reasoning, tax and request charges; not equivalent task quality',
  };
}
