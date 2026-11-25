import type { Api } from '../../http/api';
import { centresApi } from './centres.routes';
import { districtsApi } from './districts.routes';
import { documentsApi } from './documents.routes';
import { fieldsApi } from './fields.routes';
import { geographyApi } from './geography.routes';
import { optionsApi } from './options.routes';
import { statesApi } from './states.routes';
import { talukasApi } from './talukas.routes';
import { technologiesApi } from './technologies.routes';

/* What the Auditor manages: what the form asks, offers and collects, and the places. */
export const mastersApis: Api[] = [
  optionsApi,
  technologiesApi,
  documentsApi,
  fieldsApi,
  statesApi,
  districtsApi,
  talukasApi,
  centresApi,
  geographyApi,
];
