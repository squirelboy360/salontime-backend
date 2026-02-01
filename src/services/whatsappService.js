/**
 * WhatsApp Business Cloud API service.
 * Messages send FROM the salon owner's number (salon.whatsapp_phone_number_id).
 * Platform token from env; each salon has their own Phone Number ID when set.
 */
const fetch = require('node-fetch');

const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const FALLBACK_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID; // fallback if salon has none
const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';

function isEnabled(salonPhoneNumberId = null) {
  const phoneId = salonPhoneNumberId || FALLBACK_PHONE_NUMBER_ID;
  return !!(ACCESS_TOKEN && phoneId);
}

/**
 * Normalize phone to E.164 (digits only, with country code, no +).
 * @param {string} phone - Raw phone e.g. "+31612345678", "0612345678", "31612345678"
 * @returns {string|null} - E.164 without + e.g. "31612345678"
 */
function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return null;
  // If starts with 0, assume Netherlands and add 31
  if (digits.startsWith('0')) {
    return '31' + digits.slice(1);
  }
  if (!digits.startsWith('31') && digits.length <= 9) {
    return '31' + digits;
  }
  return digits;
}

/**
 * Send a WhatsApp template message.
 * @param {string} toPhone - Recipient phone (E.164 or raw)
 * @param {string} templateName - Approved template name in Meta
 * @param {string} languageCode - e.g. "en", "nl"
 * @param {Array} bodyParams - Template body parameters
 * @param {string} [phoneNumberId] - Salon's Phone Number ID (messages send FROM this number)
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendTemplate(toPhone, templateName, languageCode = 'en', bodyParams = [], phoneNumberId = null) {
  const fromPhoneId = phoneNumberId || FALLBACK_PHONE_NUMBER_ID;
  if (!isEnabled(fromPhoneId)) {
    console.warn('WhatsApp not configured for this salon - skipping send');
    return { success: false, error: 'WHATSAPP_NOT_CONFIGURED' };
  }

  const normalized = normalizePhone(toPhone);
  if (!normalized) {
    console.warn('WhatsApp: invalid phone', toPhone);
    return { success: false, error: 'INVALID_PHONE' };
  }

  const url = `https://graph.facebook.com/${API_VERSION}/${fromPhoneId}/messages`;
  const components = [];

  if (bodyParams.length > 0) {
    components.push({
      type: 'body',
      parameters: bodyParams.map((p) => ({ type: 'text', text: String(p.text || p).slice(0, 1024) })),
    });
  }

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalized,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components: components.length ? components : undefined,
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error('WhatsApp API error:', res.status, data);
      return { success: false, error: data.error?.message || `HTTP ${res.status}` };
    }

    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (err) {
    console.error('WhatsApp send error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send new booking notification (from salon's number).
 * @param {string} recipientPhone - Who receives it
 * @param {object} payload - { clientName, serviceName, date, time }
 * @param {string} lang - 'en' or 'nl'
 * @param {string} [salonPhoneNumberId] - Salon's WhatsApp Phone Number ID (sender)
 */
async function sendNewBookingNotification(recipientPhone, { clientName, serviceName, date, time }, lang = 'en', salonPhoneNumberId = null) {
  const templateName = process.env.WHATSAPP_TEMPLATE_BOOKING || 'new_booking';
  return sendTemplate(
    recipientPhone,
    templateName,
    lang === 'nl' ? 'nl' : 'en',
    [clientName, serviceName, date, time],
    salonPhoneNumberId
  );
}

/**
 * Send payment success notification (from salon's number).
 */
async function sendPaymentSuccessNotification(recipientPhone, { amount, salonName, date }, lang = 'en', salonPhoneNumberId = null) {
  const templateName = process.env.WHATSAPP_TEMPLATE_PAYMENT || 'payment_confirmation';
  return sendTemplate(
    recipientPhone,
    templateName,
    lang === 'nl' ? 'nl' : 'en',
    [String(amount), salonName, date],
    salonPhoneNumberId
  );
}

module.exports = {
  isEnabled,
  normalizePhone,
  sendTemplate,
  sendNewBookingNotification,
  sendPaymentSuccessNotification,
};
