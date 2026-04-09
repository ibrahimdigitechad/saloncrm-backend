import { queryOne } from '../db/pool';

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  from: string;
  apiKey: string;
  provider: string;
}

async function sendEmail(opts: EmailOptions): Promise<void> {
  if (opts.provider === 'resend') {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: opts.from, to: opts.to, subject: opts.subject, html: opts.html }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[Resend Error]', err);
      throw new Error(`Resend error: ${res.status}`);
    }
  } else if (opts.provider === 'sendgrid') {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: opts.to }] }],
        from: { email: opts.from },
        subject: opts.subject,
        content: [{ type: 'text/html', value: opts.html }],
      }),
    });
    if (!res.ok) throw new Error(`SendGrid error: ${res.status}`);
  }
}

function bookingConfirmationHtml(customer: any, booking: any, service: any, tenant: any): string {
  const dt = new Date(booking.start_time);
  const formatted = dt.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>Booking Confirmed</title></head>
    <body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
      <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;">
        <div style="background:#0B5ED7;padding:32px;text-align:center;">
          <h1 style="color:#fff;margin:0;font-size:24px;">${tenant.name}</h1>
          <p style="color:#93c5fd;margin:8px 0 0;">Booking Confirmation</p>
        </div>
        <div style="padding:32px;">
          <p style="font-size:16px;color:#374151;">Hi <strong>${customer.name}</strong>,</p>
          <p style="color:#6b7280;">Your appointment has been confirmed. Here are your details:</p>
          <div style="background:#f9fafb;border-radius:8px;padding:20px;margin:20px 0;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Service</td><td style="padding:8px 0;font-weight:600;text-align:right;">${service.name}</td></tr>
              <tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Date & Time</td><td style="padding:8px 0;font-weight:600;text-align:right;">${formatted}</td></tr>
              <tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Duration</td><td style="padding:8px 0;font-weight:600;text-align:right;">${service.duration_minutes} min</td></tr>
              ${booking.price ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Price</td><td style="padding:8px 0;font-weight:600;text-align:right;">${tenant.currency} ${parseFloat(booking.price).toFixed(3)}</td></tr>` : ''}
            </table>
          </div>
          <p style="color:#6b7280;font-size:14px;">Need to reschedule or cancel? Reply to this email or contact us directly.</p>
        </div>
        <div style="background:#f9fafb;padding:20px;text-align:center;">
          <p style="color:#9ca3af;font-size:12px;margin:0;">${tenant.name} · Powered by SalonCRM</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

function bookingCancellationHtml(customer: any, booking: any, service: any, tenant: any): string {
  const dt = new Date(booking.start_time);
  const formatted = dt.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });
  return `
    <!DOCTYPE html>
    <html>
    <body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:0;">
      <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:12px;padding:32px;">
        <h2 style="color:#374151;">${tenant.name} — Booking Cancelled</h2>
        <p>Hi ${customer.name}, your <strong>${service.name}</strong> appointment on <strong>${formatted}</strong> has been cancelled.</p>
        <a href="https://app.saloncrm.io/book/${tenant.slug}" style="display:inline-block;background:#0B5ED7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;margin-top:16px;">Rebook Now</a>
      </div>
    </body>
    </html>
  `;
}

export async function sendBookingConfirmation(booking: any, customer: any, service: any): Promise<void> {
  const tenant = await queryOne<any>(
    `SELECT * FROM tenants WHERE id = $1 AND notifications_email = true AND email_api_key IS NOT NULL`,
    [booking.tenant_id]
  );
  if (!tenant || !customer.email) return;

  await sendEmail({
    to: customer.email,
    subject: `Booking confirmed — ${service.name} at ${tenant.name}`,
    html: bookingConfirmationHtml(customer, booking, service, tenant),
    from: tenant.email_from || tenant.email,
    apiKey: tenant.email_api_key,
    provider: tenant.email_provider,
  });
}

export async function sendBookingCancellation(booking: any, customer: any, service: any): Promise<void> {
  const tenant = await queryOne<any>(
    `SELECT * FROM tenants WHERE id = $1 AND notifications_email = true AND email_api_key IS NOT NULL`,
    [booking.tenant_id]
  );
  if (!tenant || !customer.email) return;

  await sendEmail({
    to: customer.email,
    subject: `Booking cancelled — ${service.name} at ${tenant.name}`,
    html: bookingCancellationHtml(customer, booking, service, tenant),
    from: tenant.email_from || tenant.email,
    apiKey: tenant.email_api_key,
    provider: tenant.email_provider,
  });
}
