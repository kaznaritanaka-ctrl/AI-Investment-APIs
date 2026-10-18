import { z } from 'zod';
import { hash, stable } from '../util';
import {
  CloudControlSchema,
  CloudManifestSchema,
  cloudControlKey,
  cloudRoot,
} from './personal-cloud';
import { PersonalCloudSchema } from './personal-contract';
import { PersonalSnapshotSchema, validateSnapshot } from './personal-snapshot';
import { PersonalReviewSchema, HeadSchema } from './personal-review';
import {
  DailyCatalog,
  DailyControl,
  DailyManifest,
  dailyCatalogPage,
  dailyRoot,
  validateDailySnapshot,
} from './daily-protocol';
import { hashBytes } from './personal-daily';
import {
  NasExportBinding,
  NasExportGate,
  exportGateKey,
  exportSource,
  personalObjectKey,
  type NasExportPin,
  type ExportKind,
} from './nas-export-protocol';

type Buckets = {
  EVIDENCE: R2Bucket;
  NAS_EXPORT?: R2Bucket;
  NAS_HEALTH?: R2Bucket;
  PERSONAL_EXPORT_PINS?: string;
};
export function nasExportBinding(
  base: Buckets,
  origin: { account_id: string; private_database_id: string; bucket: string },
) {
  const pin = NasExportBinding.parse(JSON.parse(base.PERSONAL_EXPORT_PINS ?? 'null'));
  if (
    !base.NAS_EXPORT ||
    base.NAS_EXPORT === base.EVIDENCE ||
    base.NAS_EXPORT === base.NAS_HEALTH ||
    base.NAS_HEALTH === base.EVIDENCE ||
    !!base.NAS_HEALTH !== !!pin.health_bucket ||
    pin.account_id !== origin.account_id ||
    pin.private_database_id !== origin.private_database_id ||
    pin.origin_bucket !== origin.bucket
  )
    throw new Error('nas_export_binding_mismatch');
  return pin;
}
const Checkpoint = z
  .object({
    transport_hash: z.string(),
    phase: z.number().int().min(0).max(4),
    cursor: z.string().max(4096).optional(),
    run_cursor: z.string().max(4096).optional(),
    catalog_page: z.number().int().min(0).optional(),
    cleanup_cursor: z.string().max(4096).optional(),
  })
  .strict();
async function json(bucket: R2Bucket, key: string, max = 131072) {
  const o = await bucket.get(key);
  if (!o) return null;
  if (o.size > max) throw new Error('nas_export_size');
  return JSON.parse(await o.text());
}
const isDenial = (key: string) =>
  /\/(?:revocations|deletions|deleted)\//.test(key) || key.endsWith('/revoked.json');
function controlProjection(key: string, input: unknown) {
  // Denial presence is sufficient. No arbitrary reason/payload enters the export bucket.
  if (isDenial(key)) return { denied: true };
  if (key.includes('/authority/')) return DailyControl.parse(input);
  if (key.includes('/personal-heads/')) return HeadSchema.parse(input);
  if (key.includes('/personal-reviews/')) return PersonalReviewSchema.parse(input);
  if (key.includes('/personal-backups/'))
    return z
      .object({
        contract_hash: z.string().regex(/^[a-f0-9]{64}$/),
        run_id: z.string().regex(/^[a-f0-9]{64}$/),
        snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
        created_at: z.iso.datetime(),
        expires_at: z.iso.datetime(),
      })
      .strict()
      .parse(input);
  throw new Error('nas_export_control_key');
}
async function putControl(bucket: R2Bucket, key: string, value: unknown) {
  const text = stable(controlProjection(key, value));
  const previous = await json(bucket, key, 16384);
  if (previous && !isDenial(key)) {
    const next = JSON.parse(text);
    if (
      previous.sequence > next.sequence ||
      (previous.sequence === next.sequence && stable(previous) !== text) ||
      (previous.storage === 'denied' && next.storage !== 'denied') ||
      (previous.storage_ends_at &&
        (!next.storage_ends_at || next.storage_ends_at > previous.storage_ends_at))
    )
      throw new Error('nas_export_control_rollback');
  }
  await bucket.put(key, text);
}
async function parts(
  origin: R2Bucket,
  destination: R2Bucket,
  manifest: z.infer<typeof DailyManifest> | z.infer<typeof CloudManifestSchema>,
  prefix: string,
  at: string,
) {
  if (manifest.expires_at <= at || manifest.created_at > at) throw new Error('nas_export_expired');
  const blocks: Uint8Array[] = [];
  for (const [i, part] of manifest.chunks.entries()) {
    if (part.key !== prefix + 'part-' + i + '.json') throw new Error('nas_export_part_scope');
    const object = await origin.get(part.key);
    if (!object || object.size !== part.bytes) throw new Error('nas_export_part_missing');
    const body = new Uint8Array(await object.arrayBuffer());
    if ((await hashBytes(body)) !== part.sha256) throw new Error('nas_export_part_hash');
    blocks.push(body);
  }
  const all = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of blocks) {
    all.set(b, offset);
    offset += b.length;
  }
  if (all.length > 524288 || (await hashBytes(all)) !== manifest.snapshot_hash)
    throw new Error('nas_export_snapshot_hash');
  return {
    snapshot: JSON.parse(new TextDecoder().decode(all)),
    async commit() {
      for (const [i, block] of blocks.entries())
        await destination.put(manifest.chunks[i].key, block, {
          customMetadata: {
            expires_at: manifest.expires_at,
            contract_hash: manifest.contract_hash,
          },
        });
    },
  };
}
function scope(
  c: {
    cloud: { account_id: string; private_database_id: string; bucket: string };
    config: { source: { source_id: string } };
  },
  p: NasExportPin,
  source: string,
) {
  if (
    c.config.source.source_id !== source ||
    c.cloud.account_id !== p.account_id ||
    c.cloud.private_database_id !== p.private_database_id ||
    c.cloud.bucket !== p.origin_bucket
  )
    throw new Error('nas_export_origin_scope');
}
async function initialData(
  origin: R2Bucket,
  out: R2Bucket,
  p: NasExportPin,
  source: string,
  at: string,
) {
  const raw = await json(origin, cloudControlKey(source));
  if (!raw) {
    if (await out.head(cloudControlKey(source))) throw new Error('nas_export_control_missing');
    return;
  }
  const c = CloudControlSchema.parse(raw);
  if (
    c.source_id !== source ||
    c.checked_at > at ||
    Date.parse(at) - Date.parse(c.checked_at) >= 48 * 3600000
  )
    throw new Error('nas_export_control_stale');
  // The records were selected by syncCloudControl; constrain their names again before crossing buckets.
  for (const key of Object.keys(c.records)) {
    if (
      !key.includes('/' + source + '/') &&
      key !== 'research-control/revocations/' + source + '.json' &&
      key !== 'research-control/personal-cloud-first/' + source + '.json'
    )
      throw new Error('nas_export_control_scope');
    if (
      !/^research-control\/(personal-(heads|attempts|captures|cloud-first|reviews|backups)|revocations|deletions)\//.test(
        key,
      )
    )
      throw new Error('nas_export_control_scope');
  }
  const headKey = Object.keys(c.records).find((k) =>
    k.startsWith('research-control/personal-heads/'),
  );
  const nativeRoot = 'personal-research/control/' + source + '/';
  if (!headKey || !(await origin.head(nativeRoot + headKey)))
    throw new Error('nas_export_control_missing');
  if (
    stable(await json(origin, nativeRoot + headKey, 16384)) !==
    stable(JSON.parse(c.records[headKey]))
  )
    throw new Error('nas_export_control_changed');
  for (const [key, value] of Object.entries(c.records)) {
    if (!personalObjectKey(nativeRoot + key)) continue;
    const current = await json(origin, nativeRoot + key, 16384);
    if (!current || stable(current) !== stable(JSON.parse(value)))
      throw new Error('nas_export_control_changed');
    await putControl(out, nativeRoot + key, current);
  }
  const attemptKey = headKey.replace('personal-heads/', 'personal-attempts/');
  const run = z
    .object({ run_id: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(JSON.parse(c.records[attemptKey] ?? 'null')).run_id;
  const denies = [
    'research-control/revocations/' + source + '.json',
    'research-control/deletions/' + source + '/' + run + '.json',
  ];
  for (const key of denies)
    if (await origin.head(nativeRoot + key)) {
      c.denied = true;
      await putControl(out, nativeRoot + key, {});
    }
  if (
    c.latest_manifest &&
    !c.denied &&
    c.storage_state === 'continuing' &&
    !(c.storage_ends_at && c.storage_ends_at <= at)
  ) {
    const prefix = cloudRoot(source) + c.contract_hash + '/';
    if (!new RegExp('^' + prefix + '\\d{4}-\\d{2}-\\d{2}/manifest\\.json$').test(c.latest_manifest))
      throw new Error('nas_export_manifest_scope');
    const m = CloudManifestSchema.parse(await json(origin, c.latest_manifest));
    if (m.contract_hash !== c.contract_hash || m.source_id !== source)
      throw new Error('nas_export_manifest_scope');
    const transfer = await parts(
      origin,
      out,
      m,
      c.latest_manifest.replace('manifest.json', ''),
      at,
    );
    const snapshot = PersonalSnapshotSchema.parse(transfer.snapshot);
    const contract = PersonalCloudSchema.parse(
      JSON.parse(String(snapshot.tables.research_personal_contracts[0].contract_json)),
    );
    scope(contract, p, source);
    await validateSnapshot(contract, snapshot);
    if (
      snapshot.contract_hash !== m.contract_hash ||
      snapshot.created_at !== m.created_at ||
      snapshot.expires_at !== m.expires_at
    )
      throw new Error('nas_export_manifest_scope');
    await transfer.commit();
    if (
      stable(await json(origin, nativeRoot + headKey, 16384)) !==
      stable(JSON.parse(c.records[headKey]))
    )
      throw new Error('nas_export_control_changed');
    for (const key of denies)
      if (await origin.head(nativeRoot + key)) throw new Error('nas_export_control_changed');
    await out.put(c.latest_manifest, stable(m), {
      customMetadata: { expires_at: m.expires_at, contract_hash: m.contract_hash },
    });
  } else c.latest_manifest = null;
  const old = await json(out, cloudControlKey(source));
  if (
    old &&
    (old.sequence > c.sequence || old.checked_at > c.checked_at || (old.denied && !c.denied))
  )
    throw new Error('nas_export_control_rollback');
  await out.put(cloudControlKey(source), stable(c));
}
async function dailyData(
  origin: R2Bucket,
  out: R2Bucket,
  p: NasExportPin,
  source: string,
  at: string,
  cursor?: string,
  catalogPage = 0,
) {
  const root = dailyRoot(source),
    head = await json(origin, root + 'catalog.json');
  if (!head) return { cursor: undefined, catalog_page: 0 };
  const catalog = DailyCatalog.parse(head);
  if (catalog.source_id !== source || catalog.checked_at > at)
    throw new Error('nas_export_catalog_scope');
  const page = await origin.list({ prefix: root + 'runs/', cursor, limit: 1 });
  // Do not make today's run wait for a years-long history cursor. One new/latest
  // generation wins; unchanged latest leaves the slot for historical refresh.
  const latestKey = catalog.latest_run_id ? root + 'runs/' + catalog.latest_run_id + '.json' : null;
  const latest = latestKey ? await json(origin, latestKey) : null;
  const copied = latestKey ? await json(out, latestKey) : null;
  const priority = latest && (!copied || copied.snapshot_hash !== latest.snapshot_hash);
  const object = priority ? { key: latestKey! } : page.objects[0];
  if (object) {
    const m = DailyManifest.parse(await json(origin, object.key));
    if (m.source_id !== source || object.key !== root + 'runs/' + m.run_id + '.json')
      throw new Error('nas_export_manifest_scope');
    const control = DailyControl.parse(
      await json(origin, root + 'authority/' + m.contract_hash + '.json', 16384),
    );
    const denied =
      (await origin.head(root + 'revoked.json')) ||
      (await origin.head(
        'personal-research/control/' + source + '/research-control/revocations/' + source + '.json',
      )) ||
      (await origin.head(root + 'deleted/' + m.run_id + '.json'));
    if (
      !denied &&
      control.storage === 'continuing' &&
      !(control.storage_ends_at && control.storage_ends_at <= at) &&
      m.expires_at > at
    ) {
      const transfer = await parts(
        origin,
        out,
        m,
        root + 'exports/' + m.run_id + '/' + m.created_at.slice(0, 10) + '/',
        at,
      );
      const s = await validateDailySnapshot(transfer.snapshot);
      scope(s.contract, p, source);
      if (
        s.run_id !== m.run_id ||
        s.contract_hash !== m.contract_hash ||
        s.ordinal !== m.ordinal ||
        s.created_at !== m.created_at ||
        s.expires_at !== m.expires_at
      )
        throw new Error('nas_export_manifest_scope');
      await transfer.commit();
      if (
        stable(await json(origin, root + 'authority/' + m.contract_hash + '.json', 16384)) !==
          stable(control) ||
        (await origin.head(root + 'deleted/' + m.run_id + '.json')) ||
        (await origin.head(root + 'revoked.json')) ||
        (await origin.head(
          'personal-research/control/' +
            source +
            '/research-control/revocations/' +
            source +
            '.json',
        ))
      )
        throw new Error('nas_export_control_changed');
      await out.put(object.key, stable(m), { customMetadata: { expires_at: m.expires_at } });
    }
    const n = Math.floor((m.ordinal - 1) / 32),
      key = root + 'catalog/' + n + '.json';
    await out.put(key, stable(dailyCatalogPage(await json(origin, key), n)));
  }
  // Latest catalog page also carries failed/purged attempts with no run manifest.
  const last = catalog.pages.find((p) => p >= catalogPage) ?? catalog.pages[0];
  if (last !== undefined) {
    const key = root + 'catalog/' + last + '.json';
    await out.put(key, stable(dailyCatalogPage(await json(origin, key), last)));
  }
  const old = await json(out, root + 'catalog.json');
  if (old && (old.max_ordinal > catalog.max_ordinal || old.checked_at > catalog.checked_at))
    throw new Error('nas_export_catalog_rollback');
  await out.put(root + 'catalog.json', stable(catalog));
  return {
    cursor: priority ? cursor : page.truncated ? page.cursor : undefined,
    catalog_page: last === undefined ? 0 : last + 1,
  };
}

// Separate capability: no HTTP, no DB writes, no source grants. A control sweep is
// bounded to 20 objects per call; one complete snapshot (<=512KiB) crosses per sweep.
export async function syncNasExport(
  base: Buckets,
  pin: NasExportPin,
  source: string,
  kind: ExportKind,
  at: string,
) {
  exportSource.parse(source);
  nasExportBinding(base, {
    account_id: pin.account_id,
    private_database_id: pin.private_database_id,
    bucket: pin.origin_bucket,
  });
  const origin = base.EVIDENCE,
    out = base.NAS_EXPORT!,
    transport_hash = await hash(stable(pin));
  const root = 'nas-export/' + kind + '/' + source + '/',
    gateKey = exportGateKey(source, kind),
    checkpointKey = root + 'checkpoint.json',
    leaseKey = root + 'lease.json';
  const prior = await origin.get(leaseKey);
  if (prior && (await prior.json<{ until: string }>()).until > at) return { state: 'leased' };
  const lease = await origin.put(
    leaseKey,
    stable({ until: new Date(Date.parse(at) + 300000).toISOString() }),
    { onlyIf: prior ? { etagMatches: prior.etag } : { etagDoesNotMatch: '*' } },
  );
  if (!lease) return { state: 'leased' };
  const started = Date.now();
  try {
    const gate = NasExportGate.parse({
      version: 1,
      generation: crypto.randomUUID(),
      transport_hash,
      source_id: source,
      kind,
      checked_at: at,
      ready: false,
    });
    const priorGate = await json(out, gateKey, 8192);
    const previous = priorGate ? NasExportGate.parse(priorGate) : null;
    if (previous && (previous.transport_hash !== transport_hash || previous.checked_at > at))
      throw new Error('nas_export_gate_rollback');
    // Leave a guaranteed read window across at least two proposed five-minute NAS
    // polls. Otherwise a timer aligned with the collector could always see the
    // next control sweep, despite successful transfers. A newly seen source deny
    // bypasses this window. The timestamp is not refreshed while waiting.
    let newDenial = false;
    for (const key of [
      dailyRoot(source) + 'revoked.json',
      'personal-research/control/' + source + '/research-control/revocations/' + source + '.json',
    ]) {
      if ((await origin.head(key)) && !(await out.head(key))) newDenial = true;
    }
    if (previous?.ready && !newDenial && Date.parse(at) - Date.parse(previous.checked_at) < 600000)
      return { state: 'current' };
    await out.put(gateKey, stable(gate));
    const saved = await json(origin, checkpointKey, 8192);
    const cp = Checkpoint.parse(saved ?? { transport_hash, phase: 0 });
    if (cp.transport_hash !== transport_hash) throw new Error('nas_export_transport_changed');
    const prefixes =
      kind === 'initial'
        ? [
            'personal-research/control/' +
              source +
              '/research-control/personal-heads/' +
              source +
              '/',
          ]
        : [dailyRoot(source) + 'authority/', dailyRoot(source) + 'deleted/'];
    // Source-wide cancellations are always projected first, even during a paginated sweep.
    for (const key of [
      dailyRoot(source) + 'revoked.json',
      'personal-research/control/' + source + '/research-control/revocations/' + source + '.json',
    ]) {
      if (await origin.head(key)) await putControl(out, key, {});
    }
    const totalPhases = prefixes.length * 2;
    const reconcile = cp.phase >= prefixes.length;
    const prefix = prefixes[cp.phase % prefixes.length];
    if (cp.phase < totalPhases) {
      const page = await (reconcile ? out : origin).list({ prefix, limit: 20, cursor: cp.cursor });
      for (const object of page.objects)
        if (personalObjectKey(object.key)) {
          if (reconcile) {
            if (!isDenial(object.key) && !(await origin.head(object.key)))
              // Preserve the last sequence for anti-rollback, but never certify
              // this sweep while original current authority is missing.
              throw new Error('nas_export_control_missing');
            continue;
          }
          const value = await json(origin, object.key, 16384);
          if (!value) throw new Error('nas_export_control_missing');
          await putControl(out, object.key, value);
        }
      if (page.truncated) cp.cursor = page.cursor;
      else {
        cp.phase++;
        delete cp.cursor;
      }
    }
    if (kind === 'daily') {
      const data = await dailyData(origin, out, pin, source, at, cp.run_cursor, cp.catalog_page);
      cp.run_cursor = data.cursor;
      cp.catalog_page = data.catalog_page;
    }
    if (cp.phase < totalPhases) {
      await origin.put(checkpointKey, JSON.stringify(cp));
      return { state: 'control_partial' };
    }
    if (kind === 'initial') await initialData(origin, out, pin, source, at);

    // Data deletion is resumable too. Control records/gates are never TTL-deleted.
    const cleanup = await out.list({
      prefix: kind === 'initial' ? cloudRoot(source) : dailyRoot(source),
      limit: 20,
      cursor: cp.cleanup_cursor,
      include: ['customMetadata'],
    });
    const initialControl = kind === 'initial' ? await json(out, cloudControlKey(source)) : null;
    const sourceDenied =
      initialControl?.denied ||
      (await out.head(dailyRoot(source) + 'revoked.json')) ||
      (await out.head(
        'personal-research/control/' + source + '/research-control/revocations/' + source + '.json',
      ));
    for (const object of cleanup.objects) {
      const run = object.key.match(/\/(?:exports|runs)\/([a-f0-9]{64})(?:\/|\.)/)?.[1];
      const authority =
        kind === 'daily' && object.customMetadata?.contract_hash
          ? await json(
              out,
              dailyRoot(source) + 'authority/' + object.customMetadata.contract_hash + '.json',
              16384,
            )
          : null;
      const denial =
        sourceDenied ||
        (run && (await out.head(dailyRoot(source) + 'deleted/' + run + '.json'))) ||
        authority?.storage === 'denied' ||
        (authority?.storage_ends_at && authority.storage_ends_at <= at);
      if (
        (object.customMetadata?.expires_at && object.customMetadata.expires_at <= at) ||
        (denial && (kind === 'initial' || /\/(exports|runs)\//.test(object.key)))
      )
        await out.delete(object.key);
    }
    cp.cleanup_cursor = cleanup.truncated ? cleanup.cursor : undefined;
    if (Date.now() - started >= 300000 || (await origin.head(leaseKey))?.etag !== lease.etag)
      throw new Error('nas_export_lease_lost');
    // Commit only after current controls, parts, manifest and catalog are durable.
    await out.put(gateKey, stable({ ...gate, ready: true }));
    cp.phase = 0;
    await origin.put(checkpointKey, JSON.stringify(cp));
    return { state: 'complete' };
  } finally {
    await origin.put(leaseKey, stable({ until: at }), { onlyIf: { etagMatches: lease.etag } });
  }
}
