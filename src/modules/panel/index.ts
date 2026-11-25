import type { Api } from '../../http/api';
import { approvalApi } from './approval.routes';
import { batchesApi } from './batches.routes';
import { correctionsApi } from './corrections.routes';
import { filesApi } from './files.routes';
import { followUpsApi } from './follow-ups.routes';
import { linkPanelApi } from './link.routes';
import { settingsApi } from './settings.routes';
import { studentsApi } from './students.routes';
import { usersApi } from './users.routes';

/* The Auditor panel (/manage): its sign-in and users, the students, their approval, batches, the settings and the connection to Sarthi. */
export const panelApis: Api[] = [
  usersApi,
  studentsApi,
  approvalApi,
  correctionsApi,
  filesApi,
  followUpsApi,
  batchesApi,
  settingsApi,
  linkPanelApi,
];
