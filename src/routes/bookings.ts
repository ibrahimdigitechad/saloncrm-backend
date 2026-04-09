import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db/pool';
import { authenticate, requireOwner, requireStaff } from '../middleware/auth';
import { notFound, badRequest, conflict } from '../lib/errors';
import { sendBookingConfirmation, sendBookingCancellation } from '../services/notifications';

const router = Router();
router.use(authenticate);

const CreateBookingSchema = z.object({
  customer_id: z.string().uuid(),
  staff_id: z.string().uuid(),
  service_id: z.string().uuid(),
  start_time: z.string().datetime(),
  notes: z.string().optional(),
});

const UpdateBookingSchema = z.object({
  start_time: z.string().datetime().optional(),
  status: z.enum(['pending', 'confirmed', 'completed', 'cancelled', 'no-show']).optional(),
  notes: z.string().optional(),
});

// GET /bookings
router.get('/', requireStaff, async (req: Request, res: Response) => {
  const { date, staff_id, status, from, to, page = '1', limit = '50' } = req.query as Record<string, string>;
  const tenantId = req.user!.tenantId;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let conditions = ['b.tenant_id = $1'];
  const params: unknown[] = [tenantId];
  let i = 2;

  if (date) {
    conditions.push(`b.start_time::date = $${i++}`);
    params.push(date);
  }
  if (from) {
    conditions.push(`b.start_time >= $${i++}`);
    params.push(from);
  }
  if (to) {
    conditions.push(`b.start_time <= $${i++}`);
    params.push(to);
  }
  if (staff_id) {
    conditions.push(`b.staff_id = $${i++}`);
    params.push(staff_id);
  }
  if (status) {
    conditions.push(`b.status = $${i++}`);
    params.push(status);
  }

  const rows = await query(
    `SELECT b.*,
            c.name AS customer_name, c.phone AS customer_phone,
            s.name AS staff_name,
            sv.name AS service_name, sv.duration_minutes, sv.color AS service_color
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN staff s ON s.id = b.staff_id
     JOIN services sv ON sv.id = b.service_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY b.start_time ASC
     LIMIT $${i++} OFFSET $${i}`,
    [...params, parseInt(limit), offset]
  );

  res.json({ success: true, data: rows });
});

// GET /bookings/availability (must be before /:id)
router.get('/availability', async (req: Request, res: Response) => {
  const { staff_id, service_id, date } = req.query as Record<string, string>;
  if (!staff_id || !service_id || !date) {
    throw badRequest('staff_id, service_id, and date are required');
  }

  // Get staff + their working hours
  const staff = await queryOne<any>(
    'SELECT s.*, t.working_hours AS tenant_hours, t.timezone FROM staff s JOIN tenants t ON t.id = s.tenant_id WHERE s.id = $1',
    [staff_id]
  );
  if (!staff) throw notFound('Staff not found');

  // Get service duration
  const service = await queryOne<any>('SELECT duration_minutes FROM services WHERE id = $1', [service_id]);
  if (!service) throw notFound('Service not found');

  // Get existing bookings for this staff on this date
  const existing = await query<any>(
    `SELECT start_time, end_time FROM bookings
     WHERE staff_id = $1 AND start_time::date = $2 AND status NOT IN ('cancelled','no-show')
     ORDER BY start_time`,
    [staff_id, date]
  );

  const hours = staff.working_hours ?? staff.tenant_hours;
  const dayKey = new Date(date).toLocaleDateString('en-US', { weekday: 'short', timeZone: staff.timezone }).toLowerCase().slice(0, 3);
  const dayHours = hours[dayKey];

  if (!dayHours || dayHours.off) {
    return res.json({ success: true, data: [] });
  }

  const slots = generateSlots(date, dayHours.open, dayHours.close, service.duration_minutes, existing, staff.timezone);
  res.json({ success: true, data: slots });
});

// GET /bookings/:id
router.get('/:id', requireStaff, async (req: Request, res: Response) => {
  const booking = await queryOne<any>(
    `SELECT b.*,
            c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, c.tag AS customer_tag,
            s.name AS staff_name, s.phone AS staff_phone,
            sv.name AS service_name, sv.duration_minutes, sv.price AS service_price
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN staff s ON s.id = b.staff_id
     JOIN services sv ON sv.id = b.service_id
     WHERE b.id = $1 AND b.tenant_id = $2`,
    [req.params.id, req.user!.tenantId]
  );
  if (!booking) throw notFound('Booking not found');
  res.json({ success: true, data: booking });
});

// POST /bookings
router.post('/', requireStaff, async (req: Request, res: Response) => {
  const body = CreateBookingSchema.parse(req.body);
  const tenantId = req.user!.tenantId;

  // Get service to compute end_time
  const service = await queryOne<any>('SELECT * FROM services WHERE id = $1 AND tenant_id = $2 AND is_active = true', [body.service_id, tenantId]);
  if (!service) throw notFound('Service not found');

  const startTime = new Date(body.start_time);
  const endTime = new Date(startTime.getTime() + service.duration_minutes * 60000);

  // Double-booking check
  const hasConflict = await queryOne<any>(
    'SELECT check_booking_conflict($1, $2, $3) AS conflict',
    [body.staff_id, startTime.toISOString(), endTime.toISOString()]
  );
  if (hasConflict?.conflict) throw conflict('This time slot is already booked for the selected staff member.');

  // Check customer is not blocked
  const customer = await queryOne<any>('SELECT * FROM customers WHERE id = $1 AND tenant_id = $2', [body.customer_id, tenantId]);
  if (!customer) throw notFound('Customer not found');
  if (customer.is_blocked) throw badRequest('This customer is blocked from making bookings.');

  const booking = await queryOne<any>(
    `INSERT INTO bookings (tenant_id, customer_id, staff_id, service_id, start_time, end_time, notes, price, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [tenantId, body.customer_id, body.staff_id, body.service_id, startTime, endTime, body.notes ?? null, service.price, 'dashboard']
  );

  // Fire notifications async (don't block response)
  sendBookingConfirmation(booking!, customer, service).catch(console.error);

  res.status(201).json({ success: true, data: booking });
});

// PUT /bookings/:id
router.put('/:id', requireStaff, async (req: Request, res: Response) => {
  const body = UpdateBookingSchema.parse(req.body);
  const tenantId = req.user!.tenantId;

  const existing = await queryOne<any>('SELECT * FROM bookings WHERE id = $1 AND tenant_id = $2', [req.params.id, tenantId]);
  if (!existing) throw notFound('Booking not found');

  let endTime = existing.end_time;

  if (body.start_time) {
    const service = await queryOne<any>('SELECT duration_minutes FROM services WHERE id = $1', [existing.service_id]);
    const newStart = new Date(body.start_time);
    endTime = new Date(newStart.getTime() + service!.duration_minutes * 60000);

    const hasConflict = await queryOne<any>(
      'SELECT check_booking_conflict($1, $2, $3, $4) AS conflict',
      [existing.staff_id, newStart.toISOString(), endTime.toISOString(), req.params.id]
    );
    if (hasConflict?.conflict) throw conflict('This time slot conflicts with another booking.');
  }

  const updated = await queryOne<any>(
    `UPDATE bookings
     SET start_time = COALESCE($1, start_time),
         end_time   = $2,
         status     = COALESCE($3, status),
         notes      = COALESCE($4, notes)
     WHERE id = $5 AND tenant_id = $6
     RETURNING *`,
    [body.start_time ?? null, endTime, body.status ?? null, body.notes ?? null, req.params.id, tenantId]
  );

  res.json({ success: true, data: updated });
});

// DELETE /bookings/:id
router.delete('/:id', requireOwner, async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const booking = await queryOne<any>(
    `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [req.params.id, tenantId]
  );
  if (!booking) throw notFound('Booking not found');

  const customer = await queryOne<any>('SELECT * FROM customers WHERE id = $1', [booking.customer_id]);
  const service = await queryOne<any>('SELECT * FROM services WHERE id = $1', [booking.service_id]);
  sendBookingCancellation(booking, customer!, service!).catch(console.error);

  res.json({ success: true, data: booking });
});

// ── Slot generation helper ──────────────────────────────────
function generateSlots(
  date: string,
  openTime: string,
  closeTime: string,
  durationMinutes: number,
  existing: Array<{ start_time: string; end_time: string }>,
  timezone: string
): string[] {
  const [openH, openM] = openTime.split(':').map(Number);
  const [closeH, closeM] = closeTime.split(':').map(Number);

  const base = new Date(`${date}T00:00:00`);
  const open = new Date(base);
  open.setHours(openH, openM, 0, 0);
  const close = new Date(base);
  close.setHours(closeH, closeM, 0, 0);

  const slots: string[] = [];
  const cur = new Date(open);

  while (cur.getTime() + durationMinutes * 60000 <= close.getTime()) {
    const slotEnd = new Date(cur.getTime() + durationMinutes * 60000);
    const overlaps = existing.some(b => {
      const bs = new Date(b.start_time).getTime();
      const be = new Date(b.end_time).getTime();
      return cur.getTime() < be && slotEnd.getTime() > bs;
    });

    if (!overlaps) slots.push(cur.toISOString());
    cur.setMinutes(cur.getMinutes() + durationMinutes);
  }

  return slots;
}

export default router;
