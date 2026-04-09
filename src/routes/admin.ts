import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../db/pool';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { notFound } from '../lib/errors';

const router = Router();
router.use(authenticate, requireSuperAdmin);

// GET /admin/tenants
router.get('/tenants', async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT t.*,
            COUNT(DISTINCT u.id)::int AS user_count,
            COUNT(DISTINCT b.id)::int AS booking_count,
            COUNT(DISTINCT c.id)::int AS customer_count
     FROM tenants t
     LEFT JOIN users u ON u.tenant_id = t.id
     LEFT JOIN bookings b ON b.tenant_id = t.id
     LEFT JOIN customers c ON c.tenant_id = t.id
     GROUP BY t.id
     ORDER BY t.created_at DESC`
  );
  res.json({ success: true, data: rows });
});

// GET /admin/tenants/:id
router.get('/tenants/:id', async (req: Request, res: Response) => {
  const tenant = await queryOne<any>('SELECT * FROM tenants WHERE id = $1', [req.params.id]);
  if (!tenant) throw notFound('Tenant not found');
  res.json({ success: true, data: tenant });
});

// POST /admin/tenants — manual onboarding
router.post('/tenants', async (req: Request, res: Response) => {
  const body = z.object({
    business_name: z.string().min(2),
    slug: z.string().min(2).regex(/^[a-z0-9-]+$/),
    owner_email: z.string().email(),
    owner_name: z.string().min(2),
    password: z.string().min(8),
    phone: z.string().optional(),
  }).parse(req.body);

  const hash = await bcrypt.hash(body.password, 12);
  const result = await queryOne<any>(
    `SELECT register_tenant($1,$2,$3,$4,$5,$6) AS r`,
    [body.business_name, body.slug, body.owner_email, body.owner_name, hash, body.phone ?? null]
  );
  res.status(201).json({ success: true, data: result?.r });
});

// PUT /admin/tenants/:id
router.put('/tenants/:id', async (req: Request, res: Response) => {
  const body = z.object({ is_active: z.boolean(), plan: z.enum(['free', 'starter', 'pro']).optional() }).parse(req.body);
  const tenant = await queryOne<any>(
    `UPDATE tenants SET is_active=$1, plan=COALESCE($2,plan) WHERE id=$3 RETURNING id, name, slug, is_active, plan`,
    [body.is_active, body.plan ?? null, req.params.id]
  );
  if (!tenant) throw notFound('Tenant not found');
  res.json({ success: true, data: tenant });
});

export default router;
