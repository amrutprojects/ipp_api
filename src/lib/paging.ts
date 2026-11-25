import { z } from 'zod';
import type { PageMeta } from '../http/respond';
import { hasControlChars } from './text';

/* Query of a list: page, limit, free-text search, a whitelisted sort column and its order. */
export const listQuery = <S extends readonly [string, ...string[]]>(sortable: S, order: 'ASC' | 'DESC' = 'DESC') =>
  z.object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    search: z
      .string()
      .trim()
      .max(100, 'Search must be at most 100 characters')
      .refine((v) => !hasControlChars(v), 'Search contains characters that cannot be searched')
      .optional(),
    sortBy: z.enum(sortable).default(sortable[0]),
    sortOrder: z
      .enum(['ASC', 'DESC', 'asc', 'desc'])
      .default(order)
      .transform((v) => v.toUpperCase() as 'ASC' | 'DESC'),
  });

export const pageMeta = (q: { page: number; limit: number }, total: number): PageMeta => ({
  page: q.page,
  limit: q.limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / q.limit)),
});

export const offset = (q: { page: number; limit: number }) => (q.page - 1) * q.limit;

/* A LIKE pattern that matches the text literally, anywhere. */
export const contains = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/* An empty value of a filter is the same as none. */
export const blankAsMissing = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
