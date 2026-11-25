import type { Response } from 'express';
import type { FieldError } from './errors';

/* Paging of a list, plus anything a list adds (e.g. the batch size). */
export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  [extra: string]: unknown;
}

/* Every answer has the same shape: { success, status, message, data, meta? }, or with `error` on a failure. */
export function ok<T>(res: Response, data: T, message = 'Data retrieved successfully', meta?: PageMeta): void {
  res.status(200).json({ success: true, status: 200, message, data, ...(meta ? { meta } : {}) });
}

export function created<T>(res: Response, data: T, message = 'Record created successfully'): void {
  res.status(201).json({ success: true, status: 201, message, data });
}

export function fail(res: Response, status: number, message: string, code: string, details?: FieldError[]): void {
  res.status(status).json({
    success: false,
    status,
    message,
    data: null,
    error: { code, requestId: res.locals.requestId as string | undefined, ...(details?.length ? { details } : {}) },
  });
}
