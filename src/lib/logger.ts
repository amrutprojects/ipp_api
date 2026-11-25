import pino from 'pino';
import { env } from '../config/env';

/*
 * An error as it is logged: its kind, its place and, of a database error, what it is about. Never its `detail`, `where` or
 * parameters (they hold the values of the row), and never the text of a file system error (it holds the file's path).
 */
export function safeError(err: unknown) {
  if (!(err instanceof Error)) return { type: typeof err };
  const e = err as Error & { code?: string; constraint?: string; table?: string; column?: string; syscall?: string };
  return {
    type: e.name,
    message: e.syscall ? `${e.syscall} ${e.code ?? ''}`.trim() : e.message,
    code: e.code,
    constraint: e.constraint,
    table: e.table,
    column: e.column,
    /* The frames only: the first lines repeat the message. */
    stack: e.stack
      ?.split('\n')
      .filter((l) => /^\s+at /.test(l))
      .join('\n'),
  };
}

/* JSON lines in production, readable lines on a developer's machine. Secrets and personal data are never logged. */
export const logger = pino({
  level: env.isTest ? 'silent' : env.LOG_LEVEL,
  base: { service: 'ipp-backend', env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: { err: safeError },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.otp', '*.token', '*.aadhaar_number'],
    censor: '[hidden]',
  },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,service,env' },
        },
      }
    : {}),
});
