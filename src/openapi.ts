import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import type { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { z } from 'zod';
import { config } from './config';
import type { Endpoint } from './http/api';
import { PROGRAM_TITLE } from './program/constants';
import { apis } from './routes';

/* The documentation of every endpoint, made from its declaration (http/api.ts). /api/docs, and as JSON /api/openapi.json. */
const WHO: Record<Endpoint['auth'], string> = {
  public: 'Public.',
  student: 'A signed-in student.',
  panel: 'Any panel user.',
  admin: 'A panel ADMIN (a VIEWER gets 403).',
};

const failure = z.object({
  success: z.literal(false),
  status: z.number().int(),
  message: z.string(),
  data: z.null(),
  error: z.object({
    code: z.string(),
    requestId: z.string(),
    details: z.array(z.object({ field: z.string().optional(), message: z.string() })).optional(),
  }),
});

const answer = (e: Endpoint) => {
  if (e.file) return { [e.file]: { schema: z.string().openapi({ type: 'string', format: 'binary' }) } };
  const schema = z.object({
    success: z.literal(true),
    status: z.number().int(),
    message: z.string(),
    data: z.any().openapi({ description: e.returns ?? 'See the response types in docs/analysis' }),
  });
  return { 'application/json': { schema } };
};

export function openApiDocument() {
  const registry = new OpenAPIRegistry();
  for (const auth of ['student', 'panel'] as const)
    registry.registerComponent('securitySchemes', auth, { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  for (const e of apis().flatMap((a) => a.endpoints)) {
    const errors: [status: string, description: string][] = [];
    if (e.auth !== 'public') errors.push(['401', 'Not signed in, or the session has expired']);
    if (e.auth === 'admin') errors.push(['403', 'A VIEWER may not change anything']);
    if (e.params) errors.push(['404', e.notFound ?? 'Not found']);
    if (e.query || e.body || e.upload || e.multipart) errors.push(['422', 'One message per wrong field']);
    if (e.limited) errors.push(['429', 'Too many requests']);
    registry.registerPath({
      method: e.method,
      path: e.path.replace(/:([A-Za-z]+)/g, '{$1}'),
      tags: [e.tag],
      summary: e.summary,
      description: WHO[e.auth],
      security: e.auth === 'public' ? [] : [{ [e.auth === 'student' ? 'student' : 'panel']: [] }],
      request: {
        ...(e.params ? { params: e.params as z.AnyZodObject } : {}),
        ...(e.query ? { query: e.query as z.AnyZodObject } : {}),
        ...(e.body ? { body: { content: { 'application/json': { schema: e.body } } } } : {}),
        ...(e.upload
          ? {
              body: {
                description: 'One file per field; the field is the document code (PHOTO, SIGNATURE, …).',
                content: { 'multipart/form-data': { schema: z.record(z.string().openapi({ format: 'binary' })) } },
              },
            }
          : {}),
        ...(e.multipart
          ? {
              body: {
                description: e.multipart.description,
                content: { 'multipart/form-data': { schema: z.record(z.string().openapi({ format: 'binary' })) } },
              },
            }
          : {}),
      },
      responses: {
        [e.status ?? 200]: { description: e.returns ?? 'Done', content: answer(e) },
        ...Object.fromEntries(
          errors.map(([status, description]) => [status, { description, content: { 'application/json': { schema: failure } } }]),
        ),
      },
    });
  }
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: { title: `${PROGRAM_TITLE} API`, version: '1.0.0' },
    servers: config.portalMounts.map((m) => ({ url: `${config.apiPrefix}${m}` })),
  });
}

export function mountDocs(app: Express): void {
  let document: ReturnType<typeof openApiDocument> | null = null;
  const get = () => (document ??= openApiDocument());
  app.get('/api/openapi.json', (_req, res) => {
    res.json(get());
  });
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(undefined, { swaggerOptions: { url: '/api/openapi.json' } }));
}
