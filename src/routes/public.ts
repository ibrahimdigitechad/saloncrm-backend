import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db/pool';
import { badRequest, notFound, conflict } from '../lib/errors';
import { sendBookingConfirmation } from '../services/notifications';

const router = Router();

// GET /public/:slug — business info + services + staff
router.get('/:slug', async (req: Request, res: Response) => {
  const tenant = await queryOne<any>(
    `SELECT id, name, slug, phone, working_hours, timezone, currency
     FROM tenants WHERE slug = $1 AND is_active = true`,
    [req.params.slug]
  );
  if (!tenant) throw notFound('Business not found');

  const [services, staff] = await Promise.all([
    query<any>(
      `SELECT id, name, description, duration_minutes, price, color
       FROM services WHERE tenant_id = $1 AND is_active = true ORDER BY name`,
      [tenant.id]
    ),
    query<any>(
      `SELECT s.id, s.name, s.avatar_url,
              COALESCE(json_agg(ss.service_id) FILTER (WHERE ss.service_id IS NOT NULL), '[]') AS service_ids
       FROM staff s
       LEFT JOIN staff_services ss ON ss.staff_id = s.id
       WHERE s.tenant_id = $1 AND s.is_active = true
       GROUP BY s.id ORDER BY s.name`,
      [tenant.id]
    ),
  ]);

  res.json({ success: true, data: { tenant, services, staff } });
});

// GET /public/:slug/availability
router.get('/:slug/availability', async (req: Request, res: Response) => {
  const { staff_id, service_id, date } = req.query as Record<string, string>;
  if (!staff_id || !service_id || !date) throw badRequest('staff_id, service_id, and date required');

  const tenant = await queryOne<any>('SELECT * FROM tenants WHERE slug=$1', [req.params.slug]);
  if (!tenant) throw notFound('Business not found');

  const service = await queryOne<any>(
    'SELECT duration_minutes FROM services WHERE id=$1 AND tenant_id=$2 AND is_active=true',
    [service_id, tenant.id]
  );
  if (!service) throw notFound('Service not found');

  const staffMember = await queryOne<any>(
    'SELECT * FROM staff WHERE id=$1 AND tenant_id=$2 AND is_active=true',
    [staff_id, tenant.id]
  );
  if (!staffMember) throw notFound('Staff not found');

  const existing = await query<any>(
    `SELECT start_time, end_time FROM bookings
     WHERE staff_id=$1 AND start_time::date=$2 AND status NOT IN ('cancelled','no-show')`,
    [staff_id, date]
  );

  const hours = staffMember.working_hours ?? tenant.working_hours;
  const dayKey = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase().slice(0, 3);
  const dayHours = hours[dayKey];

  if (!dayHours || dayHours.off) {
    return res.json({ success: true, data: [] });
  }

  const slots = generateSlots(date, dayHours.open, dayHours.close, service.duration_minutes, existing);
  res.json({ success: true, data: slots });
});

// POST /public/:slug/book — create booking (unauthenticated customer)
router.post('/:slug/book', async (req: Request, res: Response) => {
  const body = z.object({
    customer_name: z.string().min(1).max(100),
    customer_phone: z.string().min(7).max(20),
    customer_email: z.string().email().optional(),
    staff_id: z.string().uuid(),
    service_id: z.string().uuid(),
    start_time: z.string().datetime(),
    notes: z.string().max(500).optional(),
  }).parse(req.body);

  const tenant = await queryOne<any>(
    'SELECT * FROM tenants WHERE slug=$1 AND is_active=true',
    [req.params.slug]
  );
  if (!tenant) throw notFound('Business not found');

  // Get service
  const service = await queryOne<any>(
    'SELECT * FROM services WHERE id=$1 AND tenant_id=$2 AND is_active=true',
    [body.service_id, tenant.id]
  );
  if (!service) throw notFound('Service not found');

  // Upsert customer
  let customer = await queryOne<any>(
    'SELECT * FROM customers WHERE tenant_id=$1 AND phone=$2',
    [tenant.id, body.customer_phone]
  );

  if (customer?.is_blocked) throw badRequest('Unable to complete booking. Please contact the business directly.');

  if (!customer) {
    customer = await queryOne<any>(
      `INSERT INTO customers (tenant_id, name, phone, email, tag)
       VALUES ($1,$2,$3,$4,'new') RETURNING *`,
      [tenant.id, body.customer_name, body.customer_phone, body.customer_email ?? null]
    );
  }

  const startTime = new Date(body.start_time);
  const endTime = new Date(startTime.getTime() + service.duration_minutes * 60000);

  // Double-booking check
  const hasConflict = await queryOne<any>(
    'SELECT check_booking_conflict($1,$2,$3) AS conflict',
    [body.staff_id, startTime.toISOString(), endTime.toISOString()]
  );
  if (hasConflict?.conflict) throw conflict('This slot is no longer available. Please choose another time.');

  const booking = await queryOne<any>(
    `INSERT INTO bookings (tenant_id, customer_id, staff_id, service_id, start_time, end_time, notes, price, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'public_page') RETURNING *`,
    [tenant.id, customer!.id, body.staff_id, body.service_id, startTime, endTime, body.notes ?? null, service.price]
  );

  sendBookingConfirmation(booking!, customer!, service).catch(console.error);

  res.status(201).json({
    success: true,
    data: {
      booking_id: booking!.id,
      start_time: booking!.start_time,
      service_name: service.name,
      message: 'Booking confirmed! You will receive a WhatsApp confirmation shortly.',
    },
  });
});

function generateSlots(
  date: string,
  openTime: string,
  closeTime: string,
  durationMinutes: number,
  existing: Array<{ start_time: string; end_time: string }>
): string[] {
  const [openH, openM] = openTime.split(':').map(Number);
  const [closeH, closeM] = closeTime.split(':').map(Number);
  const base = new Date(date + 'T00:00:00');
  const open = new Date(base); open.setHours(openH, openM, 0, 0);
  const close = new Date(base); close.setHours(closeH, closeM, 0, 0);
  const now = new Date();

  const slots: string[] = [];
  const cur = new Date(open);

  while (cur.getTime() + durationMinutes * 60000 <= close.getTime()) {
    const slotEnd = new Date(cur.getTime() + durationMinutes * 60000);
    const isPast = cur <= now;
    const overlaps = existing.some(b => {
      const bs = new Date(b.start_time).getTime();
      const be = new Date(b.end_time).getTime();
      return cur.getTime() < be && slotEnd.getTime() > bs;
    });
    if (!isPast && !overlaps) slots.push(cur.toISOString());
    cur.setMinutes(cur.getMinutes() + durationMinutes);
  }
  return slots;
}

export default router;
