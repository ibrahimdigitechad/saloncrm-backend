import cron from 'node-cron';
import { query } from '../db/pool';
import { sendWhatsApp } from './whatsapp';

export function startCronJobs(): void {
  // Run every hour — send reminders for bookings 24h from now
  cron.schedule('0 * * * *', async () => {
    console.log('[CRON] Checking for upcoming reminders...');
    try {
      await sendUpcomingReminders();
    } catch (err) {
      console.error('[CRON] Reminder error:', err);
    }
  });

  // Daily at midnight — mark past confirmed bookings as completed
  cron.schedule('0 0 * * *', async () => {
    try {
      const result = await query(
        `UPDATE bookings SET status = 'completed'
         WHERE status = 'confirmed' AND end_time < NOW() - INTERVAL '1 hour'`
      );
      console.log('[CRON] Auto-completed bookings');
    } catch (err) {
      console.error('[CRON] Auto-complete error:', err);
    }
  });

  console.log('[CRON] Jobs scheduled');
}

async function sendUpcomingReminders(): Promise<void> {
  // Find bookings in 23-25 hour window that haven't had a reminder sent
  const bookings = await query<any>(`
    SELECT b.*,
           c.name AS customer_name, c.phone AS customer_phone,
           s.name AS service_name, s.duration_minutes,
           t.wa_phone_number_id, t.wa_access_token, t.name AS tenant_name,
           t.notifications_wa, t.slug
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    JOIN services s ON s.id = b.service_id
    JOIN tenants t ON t.id = b.tenant_id
    WHERE b.status IN ('pending', 'confirmed')
      AND b.start_time BETWEEN NOW() + INTERVAL '23 hours' AND NOW() + INTERVAL '25 hours'
      AND t.notifications_wa = true
      AND t.wa_phone_number_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM wa_messages wm
        WHERE wm.booking_id = b.id AND wm.direction = 'outbound'
          AND wm.body LIKE '%reminder%'
          AND wm.sent_at > NOW() - INTERVAL '26 hours'
      )
  `);

  for (const booking of bookings) {
    if (!booking.customer_phone) continue;
    try {
      const dt = new Date(booking.start_time);
      const formatted = dt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

      await sendWhatsApp(
        booking.wa_phone_number_id,
        booking.wa_access_token,
        booking.customer_phone,
        `⏰ *Reminder — Tomorrow's Appointment*\n\nHi ${booking.customer_name}! Just a reminder:\n\n📅 ${formatted}\n💇 ${booking.service_name}\n\nReply *confirm* to confirm or *cancel* to cancel.\n\n— ${booking.tenant_name}`
      );

      await query(
        `INSERT INTO wa_messages (tenant_id, booking_id, customer_id, direction, body)
         VALUES ($1, $2, $3, 'outbound', 'reminder sent')`,
        [booking.tenant_id, booking.id, booking.customer_id]
      );
    } catch (err) {
      console.error(`[CRON] Failed to send reminder for booking ${booking.id}:`, err);
    }
  }

  if (bookings.length > 0) {
    console.log(`[CRON] Sent ${bookings.length} reminder(s)`);
  }
}
