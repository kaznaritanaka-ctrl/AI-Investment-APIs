import type { CollectorEnv } from './schema';
import { activeSources } from './sources';
import { collectAll } from './pipeline';
import { resumeGPURuns, queueGPURuns } from './gpu-pipeline';
import { expireGPUData } from './gpu-retention';
import { resumeModelRuns } from './models-pipeline';
import { expireModels } from './models-retention';
import { recordSummary, deliverNotifications, watchdog, expireEvidence } from './operations';
export default {
  async scheduled(controller: ScheduledController, env: CollectorEnv, _ctx: ExecutionContext) {
    if (env.COLLECTION_ENABLED !== 'true') return;
    const now = new Date().toISOString(),
      slot = new Date(controller.scheduledTime).toISOString();
    let results;
    if (controller.cron === env.COLLECTION_CRON)
      results = [
        ...(await collectAll(
          env,
          activeSources.filter((s) => !s.gpu),
          slot,
        )),
        ...(await queueGPURuns(env, activeSources, slot, now)),
      ];
    else if (controller.cron === env.GPU_RESUME_CRON) {
      // Retention uses a separate continuation slot from model ingestion.
      const retired = await expireModels(env, activeSources, now);
      results = [
        ...(retired ? [] : await resumeModelRuns(env, activeSources, now)),
        ...(await resumeGPURuns(env, activeSources, now)),
      ];
    } else if (controller.cron === env.WATCHDOG_CRON) {
      const parts = env.COLLECTION_CRON?.split(' ');
      if (!parts || parts.length !== 5 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1]))
        throw new Error('invalid_collection_cron');
      const day = new Date(controller.scheduledTime);
      day.setUTCHours(Number(parts[1]), Number(parts[0]), 0, 0);
      if (day.getTime() > controller.scheduledTime) day.setUTCDate(day.getUTCDate() - 1);
      results = [
        ...(await watchdog(
          env,
          activeSources.filter((s) => !s.gpu),
          day.toISOString(),
          now,
        )),
        ...(await resumeGPURuns(env, activeSources, now, true)),
      ];
    } else return;
    await recordSummary(env, slot, results, now);
    const notification = await deliverNotifications(env, now);
    if (notification.state === 'not_configured')
      console.warn('setup_warning:notification_not_configured');
    await expireEvidence(env, now);
    await expireGPUData(env, activeSources, now);
    await env.PUBLIC_DB.prepare(
      'INSERT INTO public_health(singleton,last_collector_completed_at,collection_enabled,monitor_connected) VALUES (1,?,1,0) ON CONFLICT(singleton) DO UPDATE SET last_collector_completed_at=excluded.last_collector_completed_at,collection_enabled=1',
    )
      .bind(now)
      .run();
  },
  async fetch() {
    return new Response('Collector has no public HTTP control surface.', { status: 404 });
  },
} satisfies ExportedHandler<CollectorEnv>;
