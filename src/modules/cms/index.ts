import type { Api } from '../../http/api';
import { cmsApi, landingApi } from './cms.routes';

/* The public landing page and what the panel edits of it (Manage → CMS). */
export const cmsApis: Api[] = [landingApi, cmsApi];
