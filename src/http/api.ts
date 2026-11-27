import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { requireAdmin, requirePanel, requireStudent } from './auth';
import { AppError, type FieldError } from './errors';
import { handle, limiter, zodDetails } from './middleware';
import { receiveDocuments } from './upload';

extendZodWithOpenApi(z);

/*
 * Every endpoint of the portal is declared once: who may call it, what it accepts, and its handler. The same declaration
 * makes the route and its documentation (openapi.ts), so the two never differ.
 *
 * The order of the checks: rate limit → who is calling → the record's id (a malformed one is a record that does not exist:
 * 404) → query and body (422, every problem at once) → handler.
 */
export type Auth = 'public' | 'student' | 'panel' | 'admin';

interface Spec<P extends z.ZodTypeAny, Q extends z.ZodTypeAny, B extends z.ZodTypeAny> {
  /* public; student = a signed-in student; panel = any panel user; admin = a panel ADMIN. */
  auth: Auth;
  summary: string;
  /* What `data` of the answer is, in words (for the documentation). */
  returns?: string;
  params?: P;
  /* The message of the 404 for a malformed id. */
  notFound?: string;
  query?: Q;
  body?: B;
  /* multipart/form-data with document files, one field per document code. */
  upload?: boolean;
  /* Any other multipart/form-data, read by its own handler (e.g. one image). */
  multipart?: { receive: RequestHandler; description: string };
  /* The stricter limit of sign-in, sign-up and OTP requests. */
  limited?: boolean;
  /* The status of a successful answer (default 200). */
  status?: 200 | 201;
  /* The answer is a file, not JSON. */
  file?: string;
}

export interface Context<P, Q, B> {
  req: Request;
  res: Response;
  params: P;
  query: Q;
  body: B;
}

export interface Endpoint extends Spec<z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny> {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  tag: string;
}

type Infer<T extends z.ZodTypeAny> = z.infer<T>;

const GUARDS: Record<Auth, RequestHandler[]> = {
  public: [],
  student: [requireStudent],
  panel: [requirePanel],
  admin: [requirePanel, requireAdmin],
};

/* One counter per client for all the sign-in, sign-up and OTP endpoints together. */
const authLimiter = limiter(config.rateLimit.authMax);

export class Api {
  readonly router = Router();
  readonly endpoints: Endpoint[] = [];

  constructor(private readonly tag: string) {}

  get = this.add('get');
  post = this.add('post');
  put = this.add('put');
  patch = this.add('patch');
  delete = this.add('delete');

  private add(method: Endpoint['method']) {
    return <
      P extends z.ZodTypeAny = z.ZodUndefined,
      Q extends z.ZodTypeAny = z.ZodUndefined,
      B extends z.ZodTypeAny = z.ZodUndefined,
    >(
      path: string,
      spec: Spec<P, Q, B>,
      handler: (c: Context<Infer<P>, Infer<Q>, Infer<B>>) => Promise<void> | void,
    ): void => {
      this.endpoints.push({ ...spec, method, path, tag: this.tag });
      const run = handle((req, res) => {
        const params = spec.params?.safeParse(req.params);
        if (params && !params.success) throw AppError.notFound(spec.notFound ?? 'Not found');
        const details: FieldError[] = [];
        const part = (name: 'query' | 'body', schema: z.ZodTypeAny | undefined): unknown => {
          if (!schema) return undefined;
          const result = schema.safeParse(req[name] ?? {});
          if (result.success) return result.data;
          details.push(...zodDetails(result.error.issues, name));
          return undefined;
        };
        const query = part('query', spec.query);
        const body = part('body', spec.body);
        if (details.length) throw AppError.validation(details);
        return handler({ req, res, params: params?.data, query, body } as Context<Infer<P>, Infer<Q>, Infer<B>>);
      });
      this.router[method](
        path,
        ...(spec.limited ? [authLimiter] : []),
        ...GUARDS[spec.auth],
        ...(spec.upload ? [receiveDocuments] : []),
        ...(spec.multipart ? [spec.multipart.receive] : []),
        run,
      );
    };
  }
}
