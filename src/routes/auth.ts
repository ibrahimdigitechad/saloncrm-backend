import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, queryOne } from '../db/pool';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  authenticate,
} from '../middleware/auth';
import { badRequest, unauthorized, conflict } from '../lib/errors';

const router = Router();

const RegisterSchema = z.object({
  business_name: z.string().min(2).max(100),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers, and hyphens only'),
  owner_name: z.string().min(2).max(100),
  owner_email: z.string().email(),
  password: z.string().min(8),
  phone: z.string().optional(),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// POST /auth/register-tenant
router.post('/register-tenant', async (req: Request, res: Response) => {
  const body = RegisterSchema.parse(req.body);
  const hash = await bcrypt.hash(body.password, 12);

  const result = await queryOne<{ register_tenant: any }>(`
    SELECT register_tenant($1, $2, $3, $4, $5, $6) AS register_tenant
  `, [body.business_name, body.slug, body.owner_email, body.owner_name, hash, body.phone ?? null]);

  const data = result?.register_tenant;
  if (!data?.success) {
    if (data?.error === 'slug_taken') throw conflict('Business URL is already taken.');
    if (data?.error === 'email_taken') throw conflict('Email is already registered.');
    throw badRequest('Registration failed.');
  }

  const user = await queryOne<any>('SELECT * FROM users WHERE id = $1', [data.user_id]);
  const tokens = buildTokens(user);

  res.status(201).json({ success: true, ...tokens });
});

// POST /auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = LoginSchema.parse(req.body);

  const user = await queryOne<any>(
    `SELECT u.*, t.is_active AS tenant_active
     FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.email = $1 AND u.is_active = true`,
    [email]
  );

  if (!user) throw unauthorized('Invalid email or password.');
  if (user.role !== 'super_admin' && !user.tenant_active) throw unauthorized('Account suspended.');

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw unauthorized('Invalid email or password.');

  res.json({ success: true, ...buildTokens(user) });
});

// POST /auth/refresh
router.post('/refresh', async (req: Request, res: Response) => {
  const { refresh_token } = req.body;
  if (!refresh_token) throw badRequest('refresh_token required');

  let decoded: any;
  try {
    decoded = verifyRefreshToken(refresh_token);
  } catch {
    throw unauthorized('Invalid refresh token');
  }

  const user = await queryOne<any>('SELECT * FROM users WHERE id = $1 AND is_active = true', [decoded.userId]);
  if (!user) throw unauthorized('User not found');

  res.json({ success: true, ...buildTokens(user) });
});

// GET /auth/me
router.get('/me', authenticate, async (req: Request, res: Response) => {
  const user = await queryOne<any>(
    `SELECT u.id, u.name, u.email, u.role, u.tenant_id,
            t.name AS business_name, t.slug, t.plan, t.currency, t.timezone
     FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1`,
    [req.user!.userId]
  );
  res.json({ success: true, data: user });
});

function buildTokens(user: any) {
  const payload = {
    userId: user.id,
    tenantId: user.tenant_id,
    role: user.role,
    email: user.email,
  };
  return {
    access_token: signAccessToken(payload),
    refresh_token: signRefreshToken(payload),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      tenant_id: user.tenant_id,
    },
  };
}

export default router;
