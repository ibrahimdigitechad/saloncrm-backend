import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { queryOne } from '../db/pool';
import { authenticate, requireOwner } from '../middleware/auth';
import { notFound, badRequest } from '../lib/errors';
import { sendTestWhatsApp } from '../services/whatsapp';

const router = Router();
router.use(authenticate, requireOwner);

const WorkingHoursSchema = z.record(
  z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  z.object({
    open: z.string().regex(/^\d{2}:\d{2}$/),
    close: z.string().regex(/^\d{2}:\d{2}$/),
    off: z.boolean(),
  })
);

// GET /settings
router.get('/', async (req: Request, res: Response) => {
  const tenant = await queryOne<any>(
    `SELECT id, name, slug, email, phone, plan, is_active,
            email_provider, email_from, notifications_wa, notifications_email,
            working_hours, timezone, currency, created_at,
            CASE WHEN wa_phone_number_id IS NOT NULL THEN true ELSE false END AS wa_configured,
            CASE WHEN email_api_key IS NOT NULL THEN true ELSE false END AS email_configured
     FROM tenants WHERE id = $1`,
    [req.user!.tenantId]
  );
  if (!tenant) throw notFound('Tenant not found');
  res.json({ success: true, data: tenant });
});

// PUT /settings
router.put('/', async (req: Request, res: Response) => {
  const body = z.object({
    name: z.string().min(2).optional(),
    phone: z.string().optional(),
    working_hours: WorkingHoursSchema.optional(),
    timezone: z.string().optional(),
    currency: z.string().length(3).optional(),
  }).parse(req.body);

  const tenant = await queryOne<any>(
    `UPDATE tenants
     SET name          = COALESCE($1, name),
         phone         = COALESCE($2, phone),
         working_hours = COALESCE($3, working_hours),
         timezone      = COALESCE($4, timezone),
         currency      = COALESCE($5, currency)
     WHERE id = $6
     RETURNING id, name, slug, email, phone, working_hours, timezone, currency`,
    [body.name ?? null, body.phone ?? null,
     body.working_hours ? JSON.stringify(body.working_hours) : null,
     body.timezone ?? null, body.currency ?? null,
     req.user!.tenantId]
  );
  res.json({ success: true, data: tenant });
});

// PUT /settings/whatsapp
router.put('/whatsapp', async (req: Request, res: Response) => {
  const body = z.object({
    wa_phone_number_id: z.string().min(1),
    wa_access_token: z.string().min(1),
    notifications_wa: z.boolean().optional(),
  }).parse(req.body);

  await queryOne(
    `UPDATE tenants
     SET wa_phone_number_id = $1,
         wa_access_token    = $2,
         notifications_wa   = COALESCE($3, notifications_wa)
     WHERE id = $4`,
    [body.wa_phone_number_id, body.wa_access_token, body.notifications_wa ?? null, req.user!.tenantId]
  );

  res.json({ success: true, message: 'WhatsApp configuration saved.' });
});

// POST /settings/whatsapp/test
router.post('/whatsapp/test', async (req: Request, res: Response) => {
  const tenant = await queryOne<any>(
    'SELECT wa_phone_number_id, wa_access_token, phone FROM tenants WHERE id = $1',
    [req.user!.tenantId]
  );
  if (!tenant?.wa_phone_number_id) throw badRequest('WhatsApp is not configured yet.');
  if (!tenant?.phone) throw badRequest('Set a business phone number first.');

  await sendTestWhatsApp(tenant.wa_phone_number_id, tenant.wa_access_token, tenant.phone);
  res.json({ success: true, message: 'Test message sent.' });
});

// PUT /settings/email
router.put('/email', async (req: Request, res: Response) => {
  const body = z.object({
    email_provider: z.enum(['resend', 'sendgrid', 'smtp']),
    email_api_key: z.string().min(1),
    email_from: z.string().email(),
    notifications_email: z.boolean().optional(),
  }).parse(req.body);

  await queryOne(
    `UPDATE tenants
     SET email_provider     = $1,
         email_api_key      = $2,
         email_from         = $3,
         notifications_email = COALESCE($4, notifications_email)
     WHERE id = $5`,
    [body.email_provider, body.email_api_key, body.email_from, body.notifications_email ?? null, req.user!.tenantId]
  );

  res.json({ success: true, message: 'Email configuration saved.' });
});

export default router;
