import type { CollectorEnv } from './schema';
import { activeSources } from './sources';
import { collectAll } from './pipeline';
import { resumeGPURuns, queueGPURuns } from './gpu-pipeline';
import { expireGPUData } from './gpu-retention';
import { resumeModelRuns } from './models-pipeline';
import { expireModels } from './models-retention';
import { recordSummary, deliverNotifications, watchdog, expireEvidence } from './operations';
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
    try {
      let results;
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
        // Retention uses a separate continuation slot from model ingestion.
        const retired = await expireModels(env, activeSources, now);
        results = [
          ...(retired ? [] : await resumeModelRuns(env, activeSources, now, false, observer)),
          ...(await resumeGPURuns(env, activeSources, now, false, observer)),
        ];
      } else if (controller.cron === env.WATCHDOG_CRON) {
        results = [
          ...(await watchdog(
            env,
            activeSources.filter((s) => !s.gpu),
            dailyCollectionSlot(env.COLLECTION_CRON, controller.scheduledTime),
            now,
            observer,
          )),
          ...(await resumeGPURuns(env, activeSources, now, true, observer)),
        ];
      } else return;
      await recordSummary(env, slot, results, new Date().toISOString(), {
        process_kind: process,
        event_scheduled_at: eventScheduled,
        logical_slot: logicalSlot ?? undefined,
      });
      const notification = await deliverNotifications(env, now);
      await expireEvidence(env, now);
      await expireGPUData(env, activeSources, now);
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
    }
  },
  async fetch() {
    return new Response('Collector has no public HTTP control surface.', { status: 404 });
  },
} satisfies ExportedHandler<CollectorEnv>;
