import { Api } from '../../http/api';
import { panelOf } from '../../http/auth';
import { created, ok } from '../../http/respond';
import { batchListQuery, batchParams, createBatchBody, updateBatchBody } from './batches.schemas';
import { batch, createBatch, listBatches, updateBatch } from './batches.service';

export const batchesApi = new Api('Panel: batches');
const api = batchesApi;
const NOT_FOUND = 'Batch not found';

api.get(
  '/manage/batches',
  {
    auth: 'panel',
    summary: 'The batches, newest first; search by code, name, center or district',
    returns: 'Batch[] (sync: whether Sarthi has it), with meta { page, limit, total, totalPages, size: the default batch size }',
    query: batchListQuery,
  },
  async ({ res, query }) => {
    const { items, meta } = await listBatches(query);
    ok(res, items, undefined, meta);
  },
);

api.post(
  '/manage/batches',
  {
    auth: 'admin',
    summary:
      'Makes a batch of approved students of one district, exactly as many as its batch size, and sends it to the Divisional Officer',
    returns: 'BatchDetail',
    body: createBatchBody,
    status: 201,
  },
  async ({ req, res, body }) =>
    created(res, await createBatch(req, panelOf(res), body), 'Batch created and sent to the Divisional Officer'),
);

api.get(
  '/manage/batches/:id',
  { auth: 'panel', summary: 'One batch with its students', returns: 'BatchDetail', params: batchParams, notFound: NOT_FOUND },
  async ({ res, params }) => ok(res, await batch(params.id)),
);

api.patch(
  '/manage/batches/:id',
  {
    auth: 'admin',
    summary: 'Changes the name, center, dates, delivery mode or technology of a batch (its students are fixed)',
    returns: 'BatchDetail',
    params: batchParams,
    notFound: NOT_FOUND,
    body: updateBatchBody,
  },
  async ({ req, res, params, body }) => ok(res, await updateBatch(req, panelOf(res), params.id, body), 'Batch saved'),
);
