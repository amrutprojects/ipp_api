import type { Api } from '../../http/api';
import { accountsApi } from './accounts.routes';
import { applicationApi } from './application.routes';
import { optionsApi } from './options.routes';
import { resubmissionApi } from './resubmission.routes';

export const studentApis: Api[] = [accountsApi, optionsApi, applicationApi, resubmissionApi];
