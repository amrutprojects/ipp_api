import { Router } from 'express';
import type { Api } from './http/api';
import { fileApis } from './modules/files';
import { mastersApis } from './modules/masters';
import { panelApis } from './modules/panel';
import { studentApis } from './modules/student';

/* Every module's endpoints. */
export const apis = (): Api[] => [...studentApis, ...panelApis, ...mastersApis, ...fileApis];

/* The portal's routes (mounted at each of config.portalMounts; they share one set of rate limits). */
export function portalRouter(): Router {
  const router = Router();
  for (const api of apis()) router.use(api.router);
  return router;
}
