import { z } from 'zod';
import { studentIds } from './common';

export const approveSelectedBody = z
  .object({
    ids: studentIds({ max: 500, twice: 'Each student may be selected only once', list: 'ids must be a list' }),
  })
  .strict();

export const verifyDocumentBody = z
  .object({
    verified: z.boolean({ required_error: 'verified is required', invalid_type_error: 'verified must be true or false' }),
  })
  .strict();
