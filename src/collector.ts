import type { CollectorEnv } from './schema';
import { activeSources } from './sources';
import { collectAll } from './pipeline';
import { recordSummary, deliverNotifications, watchdog, expireEvidence } from './operations';
export default {
  async scheduled(controller: ScheduledController, env: CollectorEnv, _ctx: ExecutionContext) {
    const now = new Date().toISOString();
    let results;
    if (controller.cron === (env.COLLECTION_CRON ?? '17 18 * * *')) {
      results = await collectAll(
        env,
        activeSources,
        new Date(controller.scheduledTime).toISOString(),
      );
    } else {
      const day = new Date(controller.scheduledTime);
      day.setUTCHours(Number(env.COLLECTION_HOUR ?? 18), Number(env.COLLECTION_MINUTE ?? 17), 0, 0);
      if (day.getTime() > controller.scheduledTime) day.setUTCDate(day.getUTCDate() - 1);
      results = await watchdog(env, activeSources, day.toISOString(), now);
    }
    await recordSummary(env, new Date(controller.scheduledTime).toISOString(), results, now);
    const notification = await deliverNotifications(env, now);
    if (notification.state === 'not_configured')
      console.warn('setup_warning:notification_not_configured');
    await expireEvidence(env, now);
  },
  async fetch() {
    return new Response('Collector has no public HTTP control surface.', { status: 404 });
  },
} satisfies ExportedHandler<CollectorEnv>;
