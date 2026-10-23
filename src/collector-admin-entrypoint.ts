import { AdminRead as BaseAdminRead } from './admin-entrypoint';
import { highresoReader } from './admin-highreso';
import type {
  HighresoAdminRead,
  HighresoRunsDTO,
  HighresoLatestPricesDTO,
} from './admin-highreso-contract';

// Private research capabilities exist only on the Collector's named service entrypoint.
export class AdminRead extends BaseAdminRead implements HighresoAdminRead {
  async highresoRuns(limit?: number): Promise<HighresoRunsDTO> {
    return highresoReader(this.env).highresoRuns(limit);
  }
  async highresoLatestPrices(): Promise<HighresoLatestPricesDTO> {
    return highresoReader(this.env).highresoLatestPrices();
  }
}
