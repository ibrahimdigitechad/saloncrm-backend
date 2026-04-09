import { Router, Request, Response } from 'express';
import { queryOne, query } from '../db/pool';
import { sendWhatsApp } from '../services/whatsapp';

const router = Router();
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || 'saloncrm_verify_token';

// GET /webhook/whatsapp — Meta verification
router.get('/whatsapp', (req: Request, res: Response) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[WA Webhook] Verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// POST /webhook/whatsapp — Incoming messages
router.post('/whatsapp', async (req: Request, res: Response) => {
  // Respond to Meta immediately (they require < 200ms)
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        const value = change.value;

        // Find tenant by wa_phone_number_id
        const phoneNumberId = value.metadata?.phone_number_id;
        const tenant = await queryOne<any>(
          'SELECT * FROM tenants WHERE wa_phone_number_id = $1 AND is_active = true',
          [phoneNumberId]
        );
        if (!tenant) continue;

        // Handle incoming message
        for (const msg of value.messages ?? []) {
          await handleIncomingMessage(tenant, msg);
        }

        // Handle delivery/read status updates
        for (const status of value.statuses ?? []) {
          await queryOne(
            `UPDATE wa_messages SET status = $1 WHERE wa_message_id = $2`,
            [status.status, status.id]
          );
        }
      }
    }
  } catch (err) {
    console.error('[WA Webhook] Error:', err);
  }
});

async function handleIncomingMessage(tenant: any, msg: any): Promise<void> {
  const fromPhone = msg.from;
  const text = msg.text?.body?.trim()?.toLowerCase() ?? '';
  const waMessageId = msg.id;

  // Find customer
  const customer = await queryOne<any>(
    'SELECT * FROM customers WHERE tenant_id = $1 AND phone = $2',
    [tenant.id, fromPhone]
  );

  // Log inbound message
  await queryOne(
    `INSERT INTO wa_messages (tenant_id, customer_id, direction, body, wa_message_id)
     VALUES ($1, $2, 'inbound', $3, $4)`,
    [tenant.id, customer?.id ?? null, msg.text?.body ?? '', waMessageId]
  );

  if (!customer) {
    await sendWhatsApp(
      tenant.wa_phone_number_id,
      tenant.wa_access_token,
      fromPhone,
      `Hello! We couldn't find your account. Please contact ${tenant.name} directly to book an appointment.`
    );
    return;
  }

  // Chatbot intent matching
  if (/\bconfirm\b|yes|نعم|confirm/.test(text)) {
    await handleConfirm(tenant, customer, fromPhone);
  } else if (/\bcancel\b|no\b|لا/.test(text)) {
    await handleCancel(tenant, customer, fromPhone);
  } else if (/\bbook(ing)?\b|\bappointment\b|موعد/.test(text)) {
    await sendWhatsApp(
      tenant.wa_phone_number_id, tenant.wa_access_token, fromPhone,
      `Hi ${customer.name}! 👋 To book an appointment, visit:\n\nhttps://app.saloncrm.io/book/${tenant.slug}\n\nOr reply with your preferred service and we'll help you.`
    );
  } else if (/\bhi\b|\bhello\b|\bhey\b|مرحبا/.test(text)) {
    await sendWhatsApp(
      tenant.wa_phone_number_id, tenant.wa_access_token, fromPhone,
      `Hi ${customer.name}! 👋 Welcome to ${tenant.name}.\n\nReply with:\n• *book* — to make a new appointment\n• *cancel* — to cancel your next appointment\n• *confirm* — to confirm your next appointment`
    );
  } else {
    await sendWhatsApp(
      tenant.wa_phone_number_id, tenant.wa_access_token, fromPhone,
      `Hi ${customer.name}! We received your message. For assistance, please reply:\n• *book* — new appointment\n• *confirm* — confirm next appointment\n• *cancel* — cancel next appointment`
    );
  }
}

async function handleConfirm(tenant: any, customer: any, fromPhone: string): Promise<void> {
  const booking = await queryOne<any>(
    `SELECT b.*, sv.name AS service_name, s.name AS staff_name
     FROM bookings b
     JOIN services sv ON sv.id = b.service_id
     JOIN staff s ON s.id = b.staff_id
     WHERE b.tenant_id = $1 AND b.customer_id = $2
       AND b.status = 'pending' AND b.start_time > NOW()
     ORDER BY b.start_time ASC LIMIT 1`,
    [tenant.id, customer.id]
  );

  if (!booking) {
    await sendWhatsApp(tenant.wa_phone_number_id, tenant.wa_access_token, fromPhone,
      `You don't have any pending appointments to confirm. Visit ${tenant.slug} to book one!`);
    return;
  }

  await queryOne(`UPDATE bookings SET status='confirmed' WHERE id=$1`, [booking.id]);
  const dt = new Date(booking.start_time);
  const formatted = dt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  await sendWhatsApp(tenant.wa_phone_number_id, tenant.wa_access_token, fromPhone,
    `✅ Confirmed! Your appointment is set:\n\n📅 ${formatted}\n💇 ${booking.service_name}\n👤 ${booking.staff_name}\n\nSee you then at ${tenant.name}!`);
}

async function handleCancel(tenant: any, customer: any, fromPhone: string): Promise<void> {
  const booking = await queryOne<any>(
    `SELECT b.*, sv.name AS service_name
     FROM bookings b
     JOIN services sv ON sv.id = b.service_id
     WHERE b.tenant_id = $1 AND b.customer_id = $2
       AND b.status IN ('pending','confirmed') AND b.start_time > NOW()
     ORDER BY b.start_time ASC LIMIT 1`,
    [tenant.id, customer.id]
  );

  if (!booking) {
    await sendWhatsApp(tenant.wa_phone_number_id, tenant.wa_access_token, fromPhone,
      `You don't have any upcoming appointments to cancel.`);
    return;
  }

  await queryOne(`UPDATE bookings SET status='cancelled' WHERE id=$1`, [booking.id]);
  await sendWhatsApp(tenant.wa_phone_number_id, tenant.wa_access_token, fromPhone,
    `❌ Your ${booking.service_name} appointment has been cancelled.\n\nTo rebook, visit:\nhttps://app.saloncrm.io/book/${tenant.slug}`);
}

export default router;
