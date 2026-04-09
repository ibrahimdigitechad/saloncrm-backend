const WA_API_VERSION = 'v19.0';
const WA_BASE = `https://graph.facebook.com/${WA_API_VERSION}`;

export async function sendWhatsApp(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  text: string
): Promise<void> {
  const res = await fetch(`${WA_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('[WA Send Error]', err);
    throw new Error(`WhatsApp API error: ${res.status}`);
  }
}

export async function sendTestWhatsApp(
  phoneNumberId: string,
  accessToken: string,
  to: string
): Promise<void> {
  await sendWhatsApp(
    phoneNumberId,
    accessToken,
    to,
    `✅ WhatsApp is connected to SalonCRM! Your notifications are working correctly.`
  );
}
