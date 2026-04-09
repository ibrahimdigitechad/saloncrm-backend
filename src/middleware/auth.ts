import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { unauthorized, forbidden } from '../lib/errors';

export interface JwtPayload {
  userId: string;
  tenantId: string;
  role: 'super_admin' | 'owner' | 'staff';
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!;

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '15m' });
}

export function signRefreshToken(payload: Pick<JwtPayload, 'userId' | 'tenantId'>): string {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: '7d' });
}

export function verifyRefreshToken(token: string): Pick<JwtPayload, 'userId' | 'tenantId'> {
  return jwt.verify(token, JWT_REFRESH_SECRET) as Pick<JwtPayload, 'userId' | 'tenantId'>;
}

// Authenticate — adds req.user
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized('Missing token');

  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET) as JwtPayload;
    next();
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}

// Require specific roles
export function requireRole(...roles: JwtPayload['role'][]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) throw forbidden('Insufficient permissions');
    next();
  };
}

export const requireOwner = requireRole('owner', 'super_admin');
export const requireStaff = requireRole('owner', 'staff', 'super_admin');
export const requireSuperAdmin = requireRole('super_admin');
