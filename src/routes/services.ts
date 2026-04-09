import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db/pool';
import { authenticate, requireOwner, requireStaff } from '../middleware/auth';
import { notFound } from '../lib/errors';

const router = Router();
router.use(authenticate);

const ServiceSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  duration_minutes: z.number().int().min(5).max(480),
  price: z.number().min(0),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  is_active: z.boolean().optional(),
});

// GET /services
router.get('/', requireStaff, async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT sv.*,
            COUNT(ss.staff_id)::int AS staff_count
     FROM services sv
     LEFT JOIN staff_services ss ON ss.service_id = sv.id
     WHERE sv.tenant_id = $1 AND sv.is_active = true
     GROUP BY sv.id
     ORDER BY sv.name`,
    [req.user!.tenantId]
  );
  res.json({ success: true, data: rows });
});

// GET /services/:id
router.get('/:id', requireStaff, async (req: Request, res: Response) => {
  const service = await queryOne<any>(
    'SELECT * FROM services WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.user!.tenantId]
  );
  if (!service) throw notFound('Service not found');
  res.json({ success: true, data: service });
});

// POST /services
router.post('/', requireOwner, async (req: Request, res: Response) => {
  const body = ServiceSchema.parse(req.body);
  const service = await queryOne<any>(
    `INSERT INTO services (tenant_id, name, description, duration_minutes, price, color)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [req.user!.tenantId, body.name, body.description ?? null, body.duration_minutes, body.price, body.color ?? '#0B5ED7']
  );
  res.status(201).json({ success: true, data: service });
});

// PUT /services/:id
router.put('/:id', requireOwner, async (req: Request, res: Response) => {
  const body = ServiceSchema.partial().parse(req.body);
  const service = await queryOne<any>(
    `UPDATE services
     SET name             = COALESCE($1, name),
         description      = COALESCE($2, description),
         duration_minutes = COALESCE($3, duration_minutes),
         price            = COALESCE($4, price),
         color            = COALESCE($5, color),
         is_active        = COALESCE($6, is_active)
     WHERE id = $7 AND tenant_id = $8
     RETURNING *`,
    [body.name ?? null, body.description ?? null, body.duration_minutes ?? null,
     body.price ?? null, body.color ?? null, body.is_active ?? null,
     req.params.id, req.user!.tenantId]
  );
  if (!service) throw notFound('Service not found');
  res.json({ success: true, data: service });
});

// DELETE /services/:id
router.delete('/:id', requireOwner, async (req: Request, res: Response) => {
  const service = await queryOne<any>(
    `UPDATE services SET is_active = false WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [req.params.id, req.user!.tenantId]
  );
  if (!service) throw notFound('Service not found');
  res.json({ success: true, data: service });
});

export default router;
