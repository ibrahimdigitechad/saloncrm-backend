import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db/pool';
import { authenticate, requireOwner, requireStaff } from '../middleware/auth';
import { notFound } from '../lib/errors';

const router = Router();
router.use(authenticate);

const WorkingHoursSchema = z.record(
  z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  z.object({
    open: z.string().regex(/^\d{2}:\d{2}$/),
    close: z.string().regex(/^\d{2}:\d{2}$/),
    off: z.boolean(),
  })
).optional();

const StaffSchema = z.object({
  name: z.string().min(1).max(100),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  working_hours: WorkingHoursSchema,
  service_ids: z.array(z.string().uuid()).optional(),
});

const UpdateStaffSchema = StaffSchema.partial();

// GET /staff
router.get('/', requireStaff, async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT s.*,
            COALESCE(json_agg(json_build_object('id', sv.id, 'name', sv.name)) FILTER (WHERE sv.id IS NOT NULL), '[]') AS services
     FROM staff s
     LEFT JOIN staff_services ss ON ss.staff_id = s.id
     LEFT JOIN services sv ON sv.id = ss.service_id
     WHERE s.tenant_id = $1 AND s.is_active = true
     GROUP BY s.id
     ORDER BY s.name`,
    [req.user!.tenantId]
  );
  res.json({ success: true, data: rows });
});

// GET /staff/:id
router.get('/:id', requireStaff, async (req: Request, res: Response) => {
  const staff = await queryOne<any>(
    `SELECT s.*,
            COALESCE(json_agg(json_build_object('id', sv.id, 'name', sv.name, 'duration_minutes', sv.duration_minutes)) FILTER (WHERE sv.id IS NOT NULL), '[]') AS services
     FROM staff s
     LEFT JOIN staff_services ss ON ss.staff_id = s.id
     LEFT JOIN services sv ON sv.id = ss.service_id
     WHERE s.id = $1 AND s.tenant_id = $2
     GROUP BY s.id`,
    [req.params.id, req.user!.tenantId]
  );
  if (!staff) throw notFound('Staff member not found');
  res.json({ success: true, data: staff });
});

// POST /staff
router.post('/', requireOwner, async (req: Request, res: Response) => {
  const body = StaffSchema.parse(req.body);
  const tenantId = req.user!.tenantId;

  await withTransaction(async (client) => {
    const { rows: [staff] } = await client.query(
      `INSERT INTO staff (tenant_id, name, phone, email, working_hours)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [tenantId, body.name, body.phone ?? null, body.email ?? null, body.working_hours ? JSON.stringify(body.working_hours) : null]
    );

    if (body.service_ids?.length) {
      const values = body.service_ids.map((sid, i) => `($1, $${i + 2})`).join(',');
      await client.query(
        `INSERT INTO staff_services (staff_id, service_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        [staff.id, ...body.service_ids]
      );
    }

    res.status(201).json({ success: true, data: staff });
  });
});

// PUT /staff/:id
router.put('/:id', requireOwner, async (req: Request, res: Response) => {
  const body = UpdateStaffSchema.parse(req.body);
  const tenantId = req.user!.tenantId;

  await withTransaction(async (client) => {
    const { rows: [staff] } = await client.query(
      `UPDATE staff
       SET name          = COALESCE($1, name),
           phone         = COALESCE($2, phone),
           email         = COALESCE($3, email),
           working_hours = COALESCE($4, working_hours),
           is_active     = COALESCE($5, is_active)
       WHERE id = $6 AND tenant_id = $7
       RETURNING *`,
      [body.name ?? null, body.phone ?? null, body.email ?? null,
       body.working_hours ? JSON.stringify(body.working_hours) : null,
       (req.body.is_active !== undefined ? req.body.is_active : null),
       req.params.id, tenantId]
    );

    if (!staff) throw notFound('Staff member not found');

    if (body.service_ids !== undefined) {
      await client.query('DELETE FROM staff_services WHERE staff_id = $1', [staff.id]);
      if (body.service_ids.length) {
        const values = body.service_ids.map((sid, i) => `($1, $${i + 2})`).join(',');
        await client.query(
          `INSERT INTO staff_services (staff_id, service_id) VALUES ${values} ON CONFLICT DO NOTHING`,
          [staff.id, ...body.service_ids]
        );
      }
    }

    res.json({ success: true, data: staff });
  });
});

// DELETE /staff/:id
router.delete('/:id', requireOwner, async (req: Request, res: Response) => {
  const staff = await queryOne<any>(
    `UPDATE staff SET is_active = false WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [req.params.id, req.user!.tenantId]
  );
  if (!staff) throw notFound('Staff member not found');
  res.json({ success: true, data: staff });
});

export default router;
