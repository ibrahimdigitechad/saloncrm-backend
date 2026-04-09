import { queryOne } from '../db/pool';
import { sendWhatsApp } from './whatsapp';
import { sendBookingConfirmation as emailConfirmation, sendBookingCancellation as emailCancellation } from './email';

export async function sendBookingConfirmation(booking: any, customer: any, service: any): Promise<void> {
  const tenant = await queryOne<any>('SELECT * FROM tenants WHERE id = $1', [booking.tenant_id]);
  if (!tenant) return;

  const dt = new Date(booking.start_time);
  const formatted = dt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  // WhatsApp
  if (tenant.notifications_wa && tenant.wa_phone_number_id && customer.phone) {
    try {
      await sendWhatsApp(
        tenant.wa_phone_number_id, tenant.wa_access_token, customer.phone,
        `✅ *Booking Confirmed!*\n\nHi ${customer.name}, your appointment is confirmed:\n\n📅 ${formatted}\n💇 ${service.name} (${service.duration_minutes} min)\n\nReply *cancel* to cancel or *confirm* to reconfirm.\n\n— ${tenant.name}`
      );
      await queryOne(
        `INSERT INTO wa_messages (tenant_id, booking_id, customer_id, direction, body) VALUES ($1,$2,$3,'outbound',$4)`,
        [tenant.id, booking.id, customer.id, `Booking confirmation sent`]
      );
    } catch (e) { console.error('[WA Confirm Error]', e); }
  }

  // Email
  if (tenant.notifications_email && tenant.email_api_key) {
    try { await emailConfirmation(booking, customer, service); } catch (e) { console.error('[Email Confirm Error]', e); }
  }
}

export async function sendBookingCancellation(booking: any, customer: any, service: any): Promise<void> {
  const tenant = await queryOne<any>('SELECT * FROM tenants WHERE id = $1', [booking.tenant_id]);
  if (!tenant) return;

  if (tenant.notifications_wa && tenant.wa_phone_number_id && customer.phone) {
    try {
      await sendWhatsApp(
        tenant.wa_phone_number_id, tenant.wa_access_token, customer.phone,
        `❌ *Booking Cancelled*\n\nHi ${customer.name}, your ${service.name} appointment has been cancelled.\n\nTo rebook: https://app.saloncrm.io/book/${tenant.slug}\n\n— ${tenant.name}`
      );
    } catch (e) { console.error('[WA Cancel Error]', e); }
  }

  if (tenant.notifications_email && tenant.email_api_key) {
    try { await emailCancellation(booking, customer, service); } catch (e) { console.error('[Email Cancel Error]', e); }
  }
}
