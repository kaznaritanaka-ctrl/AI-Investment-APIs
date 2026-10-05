import { WorkerEntrypoint } from 'cloudflare:workers';
import type { CollectorEnv } from './schema';
import { readAdmin } from './admin-read';
import type { Query, Resource } from './admin-contract';

// Only this named entrypoint is bound to the Admin. The default HTTP handler remains 404.
// The existing scheduled handler and its write capabilities are not exposed by this class.
export class AdminRead extends WorkerEntrypoint<CollectorEnv> {
  async read(resource: Resource, query: Query) {
    return readAdmin(resource, query, this.env);
  }
}
