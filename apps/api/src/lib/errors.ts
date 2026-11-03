export class HttpError extends Error {
  status: number; code: string; extra?: any;
  constructor(status: number, code: string, message: string, extra?: any) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
export const notFound = (what = 'Not found') => new HttpError(404, 'NOT_FOUND', what);
export const forbidden = (m = 'You do not have permission to do that') => new HttpError(403, 'FORBIDDEN', m);
export const unauthorized = (m = 'Sign in required') => new HttpError(401, 'UNAUTHORIZED', m);
export const badRequest = (m: string, extra?: any) => new HttpError(400, 'BAD_REQUEST', m, extra);
