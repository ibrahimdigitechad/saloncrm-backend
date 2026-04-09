import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation error',
      details: err.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
    });
  }

  // PostgreSQL errors
  const pgErr = err as { code?: string; detail?: string; message: string };
  if (pgErr.code === '23505') {
    return res.status(409).json({ error: 'Duplicate entry', detail: pgErr.detail });
  }
  if (pgErr.code === '23503') {
    return res.status(400).json({ error: 'Referenced record not found' });
  }
  if (pgErr.message?.includes('already booked')) {
    return res.status(409).json({ error: pgErr.message });
  }

  res.status(500).json({ error: 'Internal server error' });
}

export function notFound(req: Request, res: Response) {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
}
