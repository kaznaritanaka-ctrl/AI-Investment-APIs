import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Emits read-only SQL. It has no D1 client, credential handling, network, or apply mode.
export function highresoIdentityDryRun({ fromRun, toRun, recordedAt }) {
  if (!/^[a-f0-9]{64}$/.test(fromRun) || !/^5afcf3ba[a-f0-9]{56}$/.test(toRun) || fromRun === toRun)
    throw new Error('invalid_identity_runs');
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(recordedAt) ||
    !Number.isFinite(Date.parse(recordedAt))
  )
    throw new Error('invalid_identity_time');
  return `-- READ ONLY: proposed INSERTs are returned as text, never executed.
-- Private metadata only. Review unmatched groups and all 48 proposed pairs before separate approval.
WITH selected AS (
  SELECT o.*, CASE WHEN r.run_id='${fromRun}' THEN 'old' ELSE 'new' END side,
    json_extract(o.domain_json,'$.instance_id') instance_id
  FROM research_gpu_observations o JOIN research_runs r USING(run_id)
  WHERE r.source_id='highreso_public' AND r.synthetic=0 AND r.state='complete'
    AND o.method_version='domestic-gpu-html-v2'
    AND ((r.run_id='${fromRun}' AND r.scheduled_for>='2026-10-25T15:00:00.000Z' AND r.scheduled_for<'2026-10-26T15:00:00.000Z' AND o.change_kind='reobserved')
      OR (r.run_id='${toRun}' AND r.scheduled_for>='2026-10-26T15:00:00.000Z' AND r.scheduled_for<'2026-10-27T15:00:00.000Z' AND o.change_kind='first_seen'))
), tokens AS (
  SELECT s.*, j.value os_token FROM selected s
  LEFT JOIN json_each('["'||replace(replace(s.instance_id,'_','-'),'-','","')||'"]') j
    ON j.value GLOB 'ubs[0-9][0-9]' AND length(j.value)=5
), content AS (
  SELECT *, json_array(
    json_extract(domain_json,'$.offer.reported_product'),
    json_extract(domain_json,'$.offer.gpu_count'),
    json_extract(domain_json,'$.identity.vram_gb'),
    json_extract(domain_json,'$.storage_gb'), os_token,
    json_extract(domain_json,'$.offer.unit'),
    json_extract(domain_json,'$.offer.amount_decimal')
  ) content_key FROM tokens
  GROUP BY observation_id HAVING count(os_token)=1
), ranked AS (
  SELECT *, row_number() OVER(PARTITION BY side,content_key ORDER BY instance_id COLLATE BINARY,observation_id) ordinal,
    count(*) OVER(PARTITION BY side,content_key) group_count FROM content
), pairs AS (
  SELECT a.observation_id from_id,b.observation_id to_id,a.instance_id old_instance,b.instance_id new_instance
  FROM ranked a JOIN ranked b ON a.side='old' AND b.side='new' AND a.content_key=b.content_key
    AND a.ordinal=b.ordinal AND a.group_count=b.group_count
  WHERE a.instance_id<>b.instance_id
), report AS (
  SELECT 'pair' status, from_id, to_id,
    'INSERT INTO research_identity_links(link_id,source_id,from_observation_id,to_observation_id,basis,method_version,recorded_at) VALUES (' ||
    quote('hr-content-match-v1:'||from_id||':'||to_id)||','||quote('highreso_public')||','||quote(from_id)||','||quote(to_id)||','||
    quote('content_match_v1')||','||quote('domestic-gpu-html-v3')||','||quote('${recordedAt}')||') ON CONFLICT(link_id) DO NOTHING;' proposed_sql
  FROM pairs
  UNION ALL
  SELECT 'unmatched_'||side,observation_id,NULL,NULL FROM selected
    WHERE observation_id NOT IN (SELECT from_id FROM pairs UNION ALL SELECT to_id FROM pairs)
  UNION ALL
  SELECT 'selected_old_count',cast(count(*) AS TEXT),NULL,NULL FROM selected WHERE side='old'
  UNION ALL
  SELECT 'selected_new_count',cast(count(*) AS TEXT),NULL,NULL FROM selected WHERE side='new'
)
SELECT * FROM report ORDER BY status,from_id;
`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4)
    throw new Error('usage: highreso-identity-links.mjs FROM_RUN TO_RUN RECORDED_AT OUTPUT.sql');
  writeFileSync(
    args[3],
    highresoIdentityDryRun({ fromRun: args[0], toRun: args[1], recordedAt: args[2] }),
    { flag: 'wx' },
  );
  console.log('Read-only SQL file generated; no database connected.');
}
