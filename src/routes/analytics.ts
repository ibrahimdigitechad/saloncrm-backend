import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/pool';
import { authenticate, requireOwner } from '../middleware/auth';

const router = Router();
router.use(authenticate, requireOwner);

// GET /analytics/overview
router.get('/overview', async (req: Request, res: Response) => {
  const tid = req.user!.tenantId;
  const today = new Date().toISOString().split('T')[0];

  const [bookingsToday, totalCustomers, revenueMonth, bookingsWeek, statusBreakdown] = await Promise.all([
    queryOne<any>(`SELECT COUNT(*)::int AS count FROM bookings WHERE tenant_id=$1 AND start_time::date=$2 AND status!='cancelled'`, [tid, today]),
    queryOne<any>(`SELECT COUNT(*)::int AS count FROM customers WHERE tenant_id=$1 AND is_blocked=false`, [tid]),
    queryOne<any>(`SELECT COALESCE(SUM(price),0) AS total FROM bookings WHERE tenant_id=$1 AND status='completed' AND date_trunc('month',start_time)=date_trunc('month',NOW())`, [tid]),
    query<any>(`SELECT start_time::date AS date, COUNT(*)::int AS count FROM bookings WHERE tenant_id=$1 AND start_time >= NOW()-INTERVAL '7 days' AND status!='cancelled' GROUP BY 1 ORDER BY 1`, [tid]),
    query<any>(`SELECT status, COUNT(*)::int AS count FROM bookings WHERE tenant_id=$1 AND start_time >= NOW()-INTERVAL '30 days' GROUP BY status`, [tid]),
  ]);

  res.json({
    success: true,
    data: {
      bookings_today: bookingsToday?.count ?? 0,
      total_customers: totalCustomers?.count ?? 0,
      revenue_this_month: parseFloat(revenueMonth?.total ?? '0'),
      bookings_week: bookingsWeek,
      status_breakdown: statusBreakdown,
    },
  });
});

// GET /analytics/bookings?from=&to=&granularity=day|week
router.get('/bookings', async (req: Request, res: Response) => {
  const tid = req.user!.tenantId;
  const { from, to, granularity = 'day' } = req.query as Record<string, string>;

  const trunc = granularity === 'week' ? 'week' : 'day';
  const fromDate = from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const toDate = to || new Date().toISOString().split('T')[0];

  const rows = await query(
    `SELECT date_trunc($1, start_time)::date AS date,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status='completed')::int AS completed,
            COALESCE(SUM(price) FILTER (WHERE status='completed'), 0) AS revenue
     FROM bookings
     WHERE tenant_id=$2 AND start_time::date BETWEEN $3 AND $4
     GROUP BY 1 ORDER BY 1`,
    [trunc, tid, fromDate, toDate]
  );

  res.json({ success: true, data: rows });
});

// GET /analytics/services
router.get('/services', async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT sv.id, sv.name, sv.color, sv.price,
            COUNT(b.id)::int AS booking_count,
            COALESCE(SUM(b.price) FILTER (WHERE b.status='completed'), 0) AS revenue
     FROM services sv
     LEFT JOIN bookings b ON b.service_id = sv.id AND b.tenant_id = $1
     WHERE sv.tenant_id = $1
     GROUP BY sv.id
     ORDER BY booking_count DESC`,
    [req.user!.tenantId]
  );
  res.json({ success: true, data: rows });
});

// GET /analytics/staff
router.get('/staff', async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT s.id, s.name,
            COUNT(b.id)::int AS booking_count,
            COALESCE(SUM(b.price) FILTER (WHERE b.status='completed'), 0) AS revenue,
            COUNT(*) FILTER (WHERE b.status='no-show')::int AS no_shows
     FROM staff s
     LEFT JOIN bookings b ON b.staff_id = s.id AND b.tenant_id = $1
     WHERE s.tenant_id = $1 AND s.is_active = true
     GROUP BY s.id
     ORDER BY booking_count DESC`,
    [req.user!.tenantId]
  );
  res.json({ success: true, data: rows });
});

export default router;
