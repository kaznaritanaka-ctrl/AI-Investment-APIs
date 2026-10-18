import type { CollectorEnv } from './schema';
import { personalCloudScheduled } from './research/personal-cloud-scheduled';
import { dailyScheduled } from './research/daily-scheduled';
import { activeSources } from './sources';
import { collectAll } from './pipeline';
import { resumeGPURuns, queueGPURuns } from './gpu-pipeline';
import { expireGPUData } from './gpu-retention';
import { resumeCollections } from './collection-continuation';
import { recordSummary, deliverNotifications, watchdog, expireEvidence } from './operations';
import { recordOperationalNotifications } from './notifications';
import { dailyCollectionSlot, minuteSlot } from './run-identity';
import {
  sourceObserver,
  emitLog,
  safeLogCode,
  COLLECTOR_VERSION,
  type ProcessKind,
} from './telemetry';
export default {
  async scheduled(controller: ScheduledController, env: CollectorEnv, _ctx: ExecutionContext) {
    if (env.COLLECTION_ENABLED !== 'true') return;
    const process: ProcessKind | null =
      controller.cron === env.COLLECTION_CRON
        ? 'collection'
        : controller.cron === env.WATCHDOG_CRON
          ? 'watchdog'
          : controller.cron === env.GPU_RESUME_CRON
            ? 'continuation'
            : null;
    if (!process) return;
    const now = new Date().toISOString(),
      eventScheduled = new Date(controller.scheduledTime).toISOString(),
      slot = minuteSlot(eventScheduled),
      logicalSlot =
        process === 'continuation'
          ? null
          : dailyCollectionSlot(env.COLLECTION_CRON, controller.scheduledTime),
      start = performance.now(),
      observer = sourceObserver(env, process, eventScheduled),
      context = {
        collector_version: COLLECTOR_VERSION,
        process_kind: process,
        event_scheduled_at: eventScheduled,
        logical_slot: logicalSlot,
        started_at: now,
      };
    emitLog({ ...context, phase: 'collector_start' });
    // Only an idle continuation may spend a separate private-research budget.
    // Reserve every third slot for legacy GPU retention even when both private
    // modes are enabled. Missing flags preserve the production schedule exactly.
    let personalMaintenance: 'initial' | 'daily' | null = null;
    try {
      let results;
      let gpuMaintenance = false;
      if (controller.cron === env.COLLECTION_CRON)
        results = [
          ...(await collectAll(
            env,
            activeSources.filter((s) => !s.gpu),
            dailyCollectionSlot(env.COLLECTION_CRON, controller.scheduledTime),
            { observer },
          )),
          ...(await queueGPURuns(
            env,
            activeSources,
            dailyCollectionSlot(env.COLLECTION_CRON, controller.scheduledTime),
            now,
          )),
        ];
      else if (controller.cron === env.GPU_RESUME_CRON) {
        const resumed = await resumeCollections(env, activeSources, now, observer);
        results = resumed.results;
        // A full GPU page and a full retention batch have separate SQL budgets.
        gpuMaintenance = !resumed.models_work && resumed.results.length === 0;
        if (gpuMaintenance) {
          const turn = Math.floor(controller.scheduledTime / 300000) % 3;
          if (turn === 1 && env.PERSONAL_MAINTENANCE_ENABLED === 'true')
            personalMaintenance = 'initial';
          else if (turn === 2 && env.PERSONAL_DAILY_MAINTENANCE_ENABLED === 'true')
            personalMaintenance = 'daily';
          if (personalMaintenance) gpuMaintenance = false;
        }
      } else if (controller.cron === env.WATCHDOG_CRON) {
        results = [
          ...(await watchdog(
            env,
            activeSources.filter((s) => !s.gpu),
            dailyCollectionSlot(env.COLLECTION_CRON, controller.scheduledTime),
            now,
            observer,
          )),
          ...(activeSources.some((s) => s.enabled && s.models)
            ? []
            : await resumeGPURuns(env, activeSources, now, true, observer)),
        ];
      } else return;
      await recordSummary(env, slot, results, new Date().toISOString(), {
        process_kind: process,
        event_scheduled_at: eventScheduled,
        logical_slot: logicalSlot ?? undefined,
      });
      // Notification faults must not prevent retention or the normal health update.
      let notification = { state: 'unavailable', sent: 0 };
      try {
        const checkedAt = new Date().toISOString();
        await recordOperationalNotifications(env, activeSources, checkedAt);
        notification = await deliverNotifications(env, checkedAt);
      } catch {
        /* No raw error, URL or payload is logged. */
      }
      await expireEvidence(env, now);
      if (gpuMaintenance) await expireGPUData(env, activeSources, now);
      await env.PUBLIC_DB.prepare(
        'INSERT INTO public_health(singleton,last_collector_completed_at,collection_enabled,monitor_connected) VALUES (1,?,1,0) ON CONFLICT(singleton) DO UPDATE SET last_collector_completed_at=excluded.last_collector_completed_at,collection_enabled=1',
      )
        .bind(new Date().toISOString())
        .run();
      emitLog({
        ...context,
        phase: 'collector_finish',
        state: 'complete',
        finished_at: new Date().toISOString(),
        elapsed_ms: performance.now() - start,
        elapsed_scope: 'collector_invocation_including_io',
        notification_state: notification.state,
        sources_processed: results.length,
      });
    } catch (error) {
      emitLog({
        ...context,
        phase: 'collector_finish',
        state: 'failed',
        error_code: safeLogCode(error instanceof Error ? error.message : 'operation_failed'),
        finished_at: new Date().toISOString(),
        elapsed_ms: performance.now() - start,
        elapsed_scope: 'collector_invocation_including_io',
      });
      // Platform exception logs must also receive only an allowlisted code.
      throw new Error(
        safeLogCode(error instanceof Error ? error.message : 'operation_failed') ??
          'operation_failed',
      );
    } finally {
      // Once an idle budget is established, unrelated summary/health failures
      // cannot skip private maintenance. A failed resume has unknown budget and
      // defers it; never stack it onto Models, GPU capture or retention work.
      if (personalMaintenance) {
        const event =
          personalMaintenance === 'initial' ? 'personal_maintenance' : 'personal_daily_maintenance';
        try {
          console.log(
            JSON.stringify({
              event,
              sources:
                personalMaintenance === 'initial'
                  ? await personalCloudScheduled(env)
                  : await dailyScheduled(env),
            }),
          );
        } catch {
          console.warn(
            JSON.stringify({
              event,
              state: 'configuration_invalid',
            }),
          );
        }
      }
    }
  },
  async fetch() {
    return new Response('Collector has no public HTTP control surface.', { status: 404 });
  },
} satisfies ExportedHandler<CollectorEnv>;
