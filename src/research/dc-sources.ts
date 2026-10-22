import softbank from '../../config/proposals/research/dc_softbank.json';
import kddi from '../../config/proposals/research/dc_kddi.json';
import sakura from '../../config/proposals/research/dc_sakura.json';
import highreso from '../../config/proposals/research/dc_highreso.json';
import gmo from '../../config/proposals/research/dc_gmo_internet.json';
import mcdr from '../../config/proposals/research/dc_mc_digitalrealty.json';
import edgeconnex from '../../config/proposals/research/dc_edgeconnex.json';
import nttdata from '../../config/proposals/research/dc_nttdata.json';
import { ResearchConfigSchema } from './schema';

// Same private registration mechanism as Highreso; never part of config/sources or PUBLIC_DB.
export const dcResearchConfigs = [
  softbank,
  kddi,
  sakura,
  highreso,
  gmo,
  mcdr,
  edgeconnex,
  nttdata,
].map((config) => ResearchConfigSchema.parse(config));
