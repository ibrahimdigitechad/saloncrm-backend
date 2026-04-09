import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db/pool';
import { authenticate, requireOwner, requireStaff } from '../middleware/auth';
import { notFound } from '../lib/errors';

const router = Router();
router.use(authenticate);

const CustomerSchema = z.object({
  name: z.string().min(1).max(100),
  phone: z.string().min(7).max(20),
  email: z.string().email().optional(),
  tag: z.enum(['regular', 'vip', 'new', 'at-risk']).optional(),
  notes: z.string().max(2000).optional(),
});

// GET /customers
router.get('/', requireStaff, async (req: Request, res: Response) => {
  const { search, tag, is_blocked, page = '1', limit = '50' } = req.query as Record<string, string>;
  const tenantId = req.user!.tenantId;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let conditions = ['c.tenant_id = $1'];
  const params: unknown[] = [tenantId];
  let i = 2;

  if (search) {
    conditions.push(`(c.name ILIKE $${i} OR c.phone ILIKE $${i} OR c.email ILIKE $${i})`);
    params.push(`%${search}%`);
    i++;
  }
  if (tag) { conditions.push(`c.tag = $${i++}`); params.push(tag); }
  if (is_blocked !== undefined) { conditions.push(`c.is_blocked = $${i++}`); params.push(is_blocked === 'true'); }

  const rows = await query(
    `SELECT c.*,
            COUNT(b.id)::int AS booking_count,
            MAX(b.start_time) AS last_booking_at
     FROM customers c
     LEFT JOIN bookings b ON b.customer_id = c.id AND b.status NOT IN ('cancelled')
     WHERE ${conditions.join(' AND ')}
     GROUP BY c.id
     ORDER BY c.created_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...params, parseInt(limit), offset]
  );

  // Count
  const countRow = await queryOne<any>(
    `SELECT COUNT(*)::int AS total FROM customers c WHERE ${conditions.join(' AND ')}`,
    params
  );

  res.json({ success: true, data: rows, total: countRow?.total ?? 0 });
});

// GET /customers/:id — profile + full history
router.get('/:id', requireStaff, async (req: Request, res: Response) => {
  const customer = await queryOne<any>(
    'SELECT * FROM customers WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.user!.tenantId]
  );
  if (!customer) throw notFound('Customer not found');

  const bookings = await query(
    `SELECT b.*, s.name AS staff_name, sv.name AS service_name, sv.color AS service_color
     FROM bookings b
     JOIN staff s ON s.id = b.staff_id
     JOIN services sv ON sv.id = b.service_id
     WHERE b.customer_id = $1
     ORDER BY b.start_time DESC`,
    [req.params.id]
  );

  res.json({ success: true, data: { ...customer, bookings } });
});

// POST /customers
router.post('/', requireStaff, async (req: Request, res: Response) => {
  const body = CustomerSchema.parse(req.body);
  const customer = await queryOne<any>(
    `INSERT INTO customers (tenant_id, name, phone, email, tag, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [req.user!.tenantId, body.name, body.phone, body.email ?? null, body.tag ?? 'new', body.notes ?? null]
  );
  res.status(201).json({ success: true, data: customer });
});

// PUT /customers/:id
router.put('/:id', requireOwner, async (req: Request, res: Response) => {
  const body = CustomerSchema.partial().extend({ is_blocked: z.boolean().optional() }).parse(req.body);
  const customer = await queryOne<any>(
    `UPDATE customers
     SET name       = COALESCE($1, name),
         phone      = COALESCE($2, phone),
         email      = COALESCE($3, email),
         tag        = COALESCE($4, tag),
         notes      = COALESCE($5, notes),
         is_blocked = COALESCE($6, is_blocked)
     WHERE id = $7 AND tenant_id = $8
     RETURNING *`,
    [body.name ?? null, body.phone ?? null, body.email ?? null,
     body.tag ?? null, body.notes ?? null, body.is_blocked ?? null,
     req.params.id, req.user!.tenantId]
  );
  if (!customer) throw notFound('Customer not found');
  res.json({ success: true, data: customer });
});

// DELETE /customers/:id — soft block
router.delete('/:id', requireOwner, async (req: Request, res: Response) => {
  const customer = await queryOne<any>(
    `UPDATE customers SET is_blocked = true WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [req.params.id, req.user!.tenantId]
  );
  if (!customer) throw notFound('Customer not found');
  res.json({ success: true, data: customer });
});

export default router;
