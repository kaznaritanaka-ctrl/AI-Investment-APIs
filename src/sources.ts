import { SourceSchema } from './schema';
import s0 from '../config/sources/ecb.json';
import s1 from '../config/sources/models_dev.json';
import s2 from '../config/sources/openrouter.json';
import s3 from '../config/sources/sakura_dok.json';
import s4 from '../config/sources/gpusoroban.json';
import s5 from '../config/sources/lambda.json';
import s6 from '../config/sources/runpod.json';
import s7 from '../config/sources/memory.json';
import s8 from '../config/sources/electricity.json';
import s9 from '../config/sources/rates_credit.json';
import s10 from '../config/sources/capex_utilization.json';
import s11 from '../config/sources/gpu_index.json';
import s12 from '../config/sources/ebay_browse.json';
import s13 from '../config/sources/price_of_compute.json';
import s14 from '../config/sources/ccir.json';
export const sources = [s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14].map((s) =>
  SourceSchema.parse(s),
);
export const activeSources = sources.filter((s) => s.adapter !== 'candidate');
