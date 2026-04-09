export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'AppError';
  }
}
export function errorHandler(err: any, req: any, res: any, next: any) {
  const status = err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal Server Error' });
}
export function notFound(message = 'Not found') { return new AppError(404, message); }
export function unauthorized(message = 'Unauthorized') { return new AppError(401, message); }
export function forbidden(message = 'Forbidden') { return new AppError(403, message); }
export function badRequest(message = 'Bad request') { return new AppError(400, message); }
export function conflict(message = 'Conflict') { return new AppError(409, message); }
