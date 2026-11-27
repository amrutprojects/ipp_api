import type { Api } from '../../http/api';
import { filesApi } from './files.routes';

/* Documents opened by a short-lived link (program/file-links.ts). */
export const fileApis: Api[] = [filesApi];
