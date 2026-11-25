/*
 * The errors the API answers with. Clients branch on `code` (stable), never on the message. Anything thrown that is not an
 * AppError is an unexpected error: 500 with a general message, and the details only in the server log.
 */
export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  LINK_UNAUTHORIZED: 'LINK_UNAUTHORIZED',
  LINK_NOT_CONFIGURED: 'LINK_NOT_CONFIGURED',
} as const;

/* A field of the request that is wrong: `body.first_name`, `query.mobile`, `files.PHOTO`. */
export interface FieldError {
  field?: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
    public readonly details?: FieldError[],
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message = 'Invalid request', details?: FieldError[]) {
    return new AppError(400, message, ERROR_CODES.BAD_REQUEST, details);
  }
  static unauthorized(message = 'Authentication required', code: string = ERROR_CODES.UNAUTHORIZED) {
    return new AppError(401, message, code);
  }
  static forbidden(message = 'You do not have permission to perform this action', code: string = ERROR_CODES.FORBIDDEN) {
    return new AppError(403, message, code);
  }
  static notFound(message = 'Not found') {
    return new AppError(404, message, ERROR_CODES.NOT_FOUND);
  }
  static conflict(message: string, code: string = ERROR_CODES.CONFLICT) {
    return new AppError(409, message, code);
  }
  static validation(details: FieldError[], message = 'Validation failed') {
    return new AppError(422, message, ERROR_CODES.VALIDATION_ERROR, details);
  }
  static tooMany(message: string, code: string = ERROR_CODES.RATE_LIMITED) {
    return new AppError(429, message, code);
  }
  static unavailable(message: string, code: string = ERROR_CODES.SERVICE_UNAVAILABLE) {
    return new AppError(503, message, code);
  }
}
