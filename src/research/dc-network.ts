import { FetchFailure, untilAborted, type NetworkOptions } from '../network';
import { hash, stable } from '../util';
import { PUBLIC_GPU_UA } from './public-gpu-contract';
import { assertResearchAllowed, ResearchConfigSchema, type ResearchConfig } from './schema';
import { DCTrackerRecordSchema, type DCTrackerRecord } from './dc-tracker-schema';

// RFC 9309 group selection, longest matching path, Allow wins ties. Unknown/error robots fail closed.
export function dcRobotsAllowed(text: string, url: string) {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let group: (typeof groups)[number] | undefined,
    hasRules = false;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/#.*/, '').trim();
    if (!clean) continue;
    const match = /^([\w-]+)\s*:\s*(.*)$/.exec(clean);
    if (!match) throw new Error('dc_robots_invalid');
    const [, key, value] = match;
    if (key.toLowerCase() === 'user-agent') {
      if (!group || hasRules) {
        group = { agents: [], rules: [] };
        groups.push(group);
        hasRules = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (['allow', 'disallow'].includes(key.toLowerCase())) {
      if (!group) throw new Error('dc_robots_invalid');
      hasRules = true;
      if (value) group.rules.push({ allow: key.toLowerCase() === 'allow', path: value });
    }
  }
  const agent = PUBLIC_GPU_UA.split('/')[0].toLowerCase();
  const score = (g: (typeof groups)[number]) =>
    Math.max(-1, ...g.agents.map((a) => (a === '*' ? 0 : a && agent.includes(a) ? a.length : -1)));
  const specificity = Math.max(-1, ...groups.map(score));
  // Compare percent-encoded UTF-8 and decode unreserved octets on both sides.
  const normalized = (path: string) =>
    encodeURI(path)
      .replace(/%25/gi, '%')
      .replace(/%[0-9a-f]{2}/gi, (s) => {
        const char = String.fromCharCode(parseInt(s.slice(1), 16));
        return /^[a-z\d._~-]$/i.test(char) ? char : s.toUpperCase();
      });
  const path = normalized(new URL(url).pathname + new URL(url).search);
  let length = -1,
    allowed = true;
  for (const g of groups.filter((g) => score(g) === specificity && specificity >= 0)) {
    for (const rule of g.rules) {
      const pattern = normalized(rule.path);
      const expression =
        '^' +
        pattern
          .split('*')
          .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*')
          .replace(/\\\$$/, '$');
      if (new RegExp(expression).test(path)) {
        const size = pattern.replace(/[*$]/g, '').length;
        if (size > length || (size === length && rule.allow)) {
          length = size;
          allowed = rule.allow;
        }
      }
    }
  }
  return allowed;
}

async function read(config: ResearchConfig, url: string, robots: boolean, opt: NetworkOptions) {
  const now = opt.now ?? (() => new Date().toISOString());
  assertResearchAllowed(config, now(), config.terms.version);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(opt.timeout_ms ?? 15000, 15000));
  try {
    const response = await untilAborted(
      (opt.fetcher ?? fetch)(url, {
        headers: {
          'user-agent': PUBLIC_GPU_UA,
          accept: robots ? 'text/plain' : 'text/html, application/pdf',
        },
        redirect: 'manual',
        signal: controller.signal,
      }),
      controller.signal,
    );
    // No redirect, even within the same host: only reviewed primary URLs are requested.
    if (robots && [404, 410].includes(response.status)) {
      await response.body?.cancel();
      return { bytes: new Uint8Array(), type: 'text/plain', observed_at: now() };
    }
    const fail = async (code: string): Promise<never> => {
      await response.body?.cancel();
      throw new FetchFailure(code);
    };
    if (response.status >= 300 && response.status < 400) return await fail('redirect_blocked');
    if (response.status !== 200) return await fail('http_' + response.status);
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!(robots ? type === 'text/plain' : ['text/html', 'application/pdf'].includes(type)))
      return await fail('unexpected_content_type');
    const cap = Math.min(config.source.max_bytes, robots ? 16384 : 131072);
    if (Number(response.headers.get('content-length') ?? 0) > cap)
      return await fail('response_too_large');
    if (!response.body) throw new FetchFailure('empty_response');
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await untilAborted(reader.read(), controller.signal);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > cap) throw new FetchFailure('response_too_large');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!size && !robots) throw new FetchFailure('empty_response');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return { bytes, type, observed_at: now() };
  } finally {
    clearTimeout(timer);
  }
}

// Fixed targets only. No source links/instructions are followed, and PDF contents are never interpreted as text.
export async function fetchDCTrackerPage(config: ResearchConfig, opt: NetworkOptions) {
  ResearchConfigSchema.parse(config);
  const access = config.dc_access;
  if (config.adapter !== 'dc_tracker' || !access)
    throw new Error('dc_tracker_live_scope_unreviewed');
  let requests = 0;
  const bounded = {
    ...opt,
    fetcher: (async (url, init) => {
      if (++requests > 3) throw new FetchFailure('research_request_budget_exhausted');
      return (opt.fetcher ?? fetch)(url, init);
    }) as typeof fetch,
  };
  const robots = await read(
    config,
    new URL('/robots.txt', config.source.source_url).href,
    true,
    bounded,
  );
  const rules = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(robots.bytes);
  // Validate all paths before any page request. No cached permission between runs.
  if (access.projects.some((p) => !dcRobotsAllowed(rules, p.url)))
    throw new FetchFailure('dc_robots_disallowed');
  const records: DCTrackerRecord[] = [];
  for (const project of access.projects) {
    const page = await read(config, project.url, false, bounded);
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', page.bytes)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    let title: string | null = null;
    // Conservative title capture, never a factual capacity/status/financial claim.
    if (page.type === 'text/html') {
      const html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(page.bytes);
      title = /<title\b[^>]*>([^<]*)<\/title\s*>/i.exec(html)?.[1]?.trim().slice(0, 500) || null;
    } else if (new TextDecoder().decode(page.bytes.slice(0, 5)) !== '%PDF-')
      throw new Error('dc_pdf_invalid');
    const disclosure = await hash(project.url);
    const recordKey = await hash(
      stable([config.source.source_id, disclosure, 'project', project.project_id, 'disclosure']),
    );
    records.push(
      DCTrackerRecordSchema.parse({
        record_key: recordKey,
        disclosure_id: disclosure,
        entity: {
          entity_id: config.source.source_id,
          name_ja: config.source.operator,
          corporate_number: null,
        },
        project: {
          project_id: project.project_id,
          name: project.title,
          operator_entity_id: config.source.source_id,
          country: 'JP',
          prefecture: project.prefecture,
          tracked_since: config.source.policy.valid_from.slice(0, 10),
          tracking_status: 'active',
        },
        site: null,
        phase: null,
        field: 'disclosure',
        scope: 'project',
        scope_id: project.project_id,
        value_text: title,
        value_decimal: null,
        unit: null,
        as_of_date: page.observed_at.slice(0, 10),
        evidence: {
          source_id: config.source.source_id,
          source_url: project.url,
          source_policy_version: config.source.policy.version,
          observed_at: page.observed_at,
          published_at: null,
          source_date: null,
          evidence_ref: digest,
          basis: 'announced',
          confidence: 'unverified',
        },
        evidence_sha256: digest,
        evidence_level: 'primary_disclosure',
        source_quote: title,
        drafted_by: 'deterministic',
        status: 'draft',
        change: null,
        financing: null,
      }),
    );
  }
  return {
    text: stable({
      page: 0,
      records,
      reported_total: records.length,
      next_page: null,
      coverage: 'complete',
      reasons: [],
    }),
    observed_at: (opt.now ?? (() => new Date().toISOString()))(),
    status: 200,
  };
}
