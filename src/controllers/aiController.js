const { GoogleGenerativeAI } = require('@google/generative-ai');
const supabaseService = require('../services/supabaseService');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const config = require('../config');
const { supabaseAdmin, getAuthenticatedClient } = require('../config/database');
const http = require('http');
const https = require('https');
const { URL } = require('url');

class AIController {
  constructor() {
    // Initialize Gemini AI
    if (config.ai.gemini_api_key) {
      this.genAI = new GoogleGenerativeAI(config.ai.gemini_api_key);
      this.model = this.genAI.getGenerativeModel({ model: config.ai.gemini_model });
    } else {
      this.model = null;
    }
  }

  // Get system prompt for salon booking assistant
  getSystemPrompt(userContext) {
    const contextInfo = [];
    
    if (userContext.name) {
      contextInfo.push(`User's name: ${userContext.name}`);
    }
    
    if (userContext.language) {
      contextInfo.push(`User's preferred language: ${userContext.language}`);
    }
    
    if (userContext.location) {
      contextInfo.push(`User's location (pass as latitude & longitude in /api/salons/search or /api/salons/nearby): ${userContext.location.latitude}, ${userContext.location.longitude}`);
    }
    
    if (userContext.recentBookings && userContext.recentBookings.length > 0) {
      contextInfo.push(`Recent bookings: ${userContext.recentBookings.length} booking(s)`);
    }
    
    if (userContext.favoriteSalons && userContext.favoriteSalons.length > 0) {
      contextInfo.push(`Favorite salons: ${userContext.favoriteSalons.length} salon(s)`);
    }

    if (userContext.mySalonId) {
      contextInfo.push(`User is a salon owner. Their salon ID: ${userContext.mySalonId}. For "where is it" or "where is my salon" or "waar is het" or "waar is mijn salon" when they do not name a salon, call GET /api/salons/my/salon to get their salon and return the address—do NOT ask "which salon?".`);
    }

    return `You are a friendly, conversational AI assistant for SalonTime—a salon booking app. Think of yourself as a helpful friend who cares about making the user's salon experience great.

**YOUR PERSONALITY:**
- Warm, friendly, and genuinely helpful
- Natural and conversational—never robotic or menu-like
- Answer the actual question first, then add details
- Match the user's language (Dutch or English)

**CRITICAL RULES:**

1. **ALWAYS ANSWER THE ACTUAL QUESTION FIRST**
   - "Do I have appointments today?" → Tell them yes/no and show the appointments
   - "Where is the salon?" → Give the address and map link
   - "Do I have a salon?" → Answer whether they OWN a salon (yes/no + name if yes). Do NOT show appointments.
   - Never respond with "How can I help you?" when they just asked something specific

2. **BE CONVERSATIONAL, NOT A ROBOT**
   - ✅ "You've got 2 appointments today!"
   - ❌ "I have processed your request. How can I help you?"
   - ✅ "Yes! Your payment went through successfully ✓"
   - ❌ "I need to fetch that information. One moment."

3. **UNDERSTAND CONTEXT**
   - "The first one" / "I love it" = use the item you just showed
   - "Where is it?" after talking about their salon = GET /api/salons/my/salon (if they own a salon)
   - "Where is it?" after showing a booking = salon from that booking
   - Don't ask "which salon?" when context is obvious

4. **FETCH DATA IMMEDIATELY—NO EXCUSES**
   - Never say "I'm working on it" or "Let me fetch that"
   - Call the API and respond with the actual data
   - For sales/revenue: fetch bookings + payments, sum amounts, respond with the number (e.g. "You've earned €250.50 today")

5. **"DO I HAVE A SALON?" = OWNERSHIP, NOT APPOINTMENTS**
   - "Do I have a salon?" / "Heb ik een salon?" = Do they OWN a salon? Check User Context (salon owner / salon ID).
   - If yes: "Yes, you have a salon: [name]" (GET /api/salons/my/salon for the name)
   - If no: "No, you don't have a salon registered."
   - Do NOT call GET /api/bookings or show appointments for this question.

**HOW TO HANDLE REQUESTS:**

**GREETINGS** (hi, hello, hallo, hey): Respond warmly. Don't call APIs. "Hey! What can I do for you today?" or "Hallo! Waar kan ik je mee helpen?"

**APPOINTMENTS/BOOKINGS** (do I have appointments, what's my schedule, heb ik afspraken):
- GET /api/bookings (upcoming=true for future, false for past). For "today" fetch both and filter to today.
- Respond naturally: "You've got 2 appointments today: one at Hair Studio at 2pm and another at 4pm."
- Show booking cards in <output> with data-booking-id.

**SALON SEARCH** (find a salon, best salons, I'm looking for [name]):
- Name mentioned → GET /api/salons/search?q=[name]
- Best/top rated → GET /api/salons/search?sort=rating&latitude=[lat]&longitude=[lng] or GET /api/salons/popular
- Show salon cards in <output> with data-salon-id.

**PAYMENT STATUS** (was my payment successful, check payment):
- GET /api/bookings + GET /api/payments/history, match booking_id, then answer: "Yes! Your payment of €45 went through ✓" or "Payment is still pending."

**SALES/REVENUE** (how much did I earn, sales today, omzet):
- Salon owners: try GET /api/analytics first. Otherwise GET /api/bookings + GET /api/payments/history, sum successful payments.
- Respond with the amount: "You've earned €250.50 today from 5 bookings!"

**LOCATION/ADDRESS** (where is it, address):
- User owns a salon and asks "where is it" without naming one → GET /api/salons/my/salon
- Asking about a salon you just showed → GET /api/salons/[id] from context
- Give address + Google Maps link: <a href="maps-url">Open in Google Maps</a>

**SERVICES** (what do they offer): GET /api/salons/[id]/services from context. Show service cards.

**FOLLOW-UPS:** "The first one" = first item you showed. "What about yesterday?" = fetch data for yesterday. "Check if it's paid" = payment status for the booking you discussed.

**AVAILABLE APIS:** make_api_request with:
- GET /api/bookings (params: upcoming=true|false, limit)
- GET /api/salons/search (q, latitude, longitude, sort)
- GET /api/salons/popular
- GET /api/salons/nearby (latitude, longitude)
- GET /api/salons/{id}, GET /api/salons/{id}/services
- GET /api/salons/my/salon (for salon owners—use for "where is my salon" / "do I have a salon" name)
- GET /api/payments/history
- GET /api/analytics (salon owners: revenue, etc.)
- GET /api/favorites
- POST /api/bookings (body: salon_id, service_id, appointment_date, start_time, end_time)

**OUTPUT:** Use HTML in <output> for lists. Use class="ai-card", data-booking-id or data-salon-id. For links use <a href="url"> only (no target="_blank"). For simple answers use natural text with **bold** if needed.

**FORBIDDEN:** "I have processed your request" | "How can I help you?" (when they asked something specific) | "I'm not sure what you need" (when context is clear) | "I can't search" | "Let me fetch that" | "Which salon?" (when they said "the first one") | Showing appointments when they asked "Do I have a **salon**?"

**EXAMPLES:**
- "Do I have appointments today?" → [Fetch bookings] "You've got 2 appointments today! …"
- "Do I have a salon?" → [Check context] "Yes, you have a salon: Hair Studio." or "No, you don't have a salon registered."
- "How much did I earn today?" → [Fetch + calculate] "You've earned €250.50 today from 5 bookings!"
- [After showing salons] "I love the first one!" → "Great choice! Want me to help you book there?"

${contextInfo.length > 0 ? `\n**CURRENT USER CONTEXT:**\n${contextInfo.join('\n')}\n` : ''}

Remember: Answer what they asked, use context, fetch immediately, and be human. ${userContext.language === 'nl' ? 'Respond in Dutch (Nederlands).' : 'Respond in English.'}`;
  }

  /**
   * If the AI echoed raw API JSON instead of generating HTML, parse it and return HTML.
   * Returns null if aiResponse is not raw API-shaped JSON.
   */
  _convertRawJsonToHtml(aiResponse, message, userContext) {
    if (!aiResponse || typeof aiResponse !== 'string') return null;
    const t = aiResponse.trim();
    if (!t.startsWith('{') || !t.endsWith('}')) return null;
    if (!t.includes('"bookings"') && !t.includes('"salons"') && !t.includes('"favorites"') &&
        !(t.includes('"data"') && (t.includes('bookings') || t.includes('salons') || t.includes('favorites'))))
      return null;
    let parsed;
    try { parsed = JSON.parse(t); } catch (e) { return null; }

    let dataArray = [];
    const d = parsed.data || parsed;
    if (Array.isArray(d)) dataArray = d;
    else if (Array.isArray(d?.bookings)) dataArray = d.bookings;
    else if (Array.isArray(d?.salons)) dataArray = d.salons;
    else if (Array.isArray(d?.favorites)) dataArray = d.favorites;
    else if (Array.isArray(d?.data)) dataArray = d.data;
    else if (Array.isArray(parsed.bookings)) dataArray = parsed.bookings;
    else if (Array.isArray(parsed.salons)) dataArray = parsed.salons;
    else if (Array.isArray(parsed.favorites)) dataArray = parsed.favorites;
    if (dataArray.length === 0) return null;

    const isBooking = dataArray[0] && (dataArray[0].appointment_date != null || dataArray[0].start_time != null ||
      (dataArray[0].salon_id && (dataArray[0].salons || dataArray[0].salon)));
    const lang = userContext?.language === 'nl' ? 'nl' : 'en';

    if (isBooking) {
      const toShow = dataArray.slice(0, 100);
      const now = new Date();
      const bookingCards = toShow.map(booking => {
        const salonName = booking.salon?.business_name || booking.salons?.business_name || booking.salonName || 'Salon';
        const serviceName = booking.service?.name || booking.services?.name || booking.serviceName || 'Service';
        const date = booking.appointment_date || booking.appointmentDate || '';
        const time = (booking.start_time || booking.startTime || '').toString().slice(0, 5);
        const bookingId = booking.id || '';
        const status = booking.status || '';
        const dt = date && time ? new Date(date + 'T' + time + ':00') : null;
        const isUpcoming = dt ? dt >= now : false;
        const isCancelled = status === 'cancelled';
        const dataAttrs = `data-booking-id="${bookingId}" data-booking-status="${status}" data-is-upcoming="${isUpcoming}" data-is-cancelled="${isCancelled}"`;
        const label = isCancelled ? ' (Geannuleerd)' : (isUpcoming ? '' : ' (Afgelopen)');
        return `<div class="ai-card" ${dataAttrs} style="padding: 16px; margin: 8px 0; border: 1px solid #e0e0e0; border-radius: 8px; cursor: pointer;"><h3 style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600;">${salonName}${label}</h3><p style="margin: 4px 0; color: #666; font-size: 14px;">${serviceName}</p><p style="margin: 4px 0; color: #666; font-size: 14px;">📅 ${date} om ${time}</p></div>`;
      }).join('');

      const heading = lang === 'nl' ? `Je hebt ${toShow.length} boeking(en):` : `You have ${toShow.length} booking(s):`;
      return `<output><p style="margin-bottom: 16px; font-size: 16px; font-weight: 600;">${heading}</p>${bookingCards}</output>`;
    }

    // Generic: salons, favorites, services – infer from data shape, not keywords
    const dataCards = dataArray.slice(0, 100).map((item, index) => {
      const salon = item.salons || item.salon;
      const sid = item.salon_id || salon?.id || (salon ? item.id : null);
      const title = salon?.business_name || item.business_name || item.name || item.title || `Item ${index + 1}`;
      const dataAttr = sid ? `data-salon-id="${sid}"` : `data-id="${item.id || ''}"`;
      const sub = (item.city || salon?.city) ? ` · ${item.city || salon?.city}` : '';
      return `<div class="ai-card" ${dataAttr} style="padding: 16px; margin: 8px 0; border: 1px solid #e0e0e0; border-radius: 8px; cursor: pointer;"><h3 style="margin: 0; font-size: 16px; font-weight: 600;">${title}${sub}</h3></div>`;
    }).join('');
    const heading = lang === 'nl' ? `Gevonden resultaten (${dataArray.length})` : `Results (${dataArray.length})`;
    return `<output><p style="margin-bottom: 16px; font-size: 16px; font-weight: 600;">${heading}:</p>${dataCards}</output>`;
  }

  // Resolve salon id from conversation (last data-salon-id in assistant messages)
  _getSalonIdFromHistory(historyMessages) {
    if (!Array.isArray(historyMessages)) return null;
    for (let i = historyMessages.length - 1; i >= 0; i--) {
      const m = historyMessages[i];
      if (m?.role === 'assistant' && typeof m.content === 'string') {
        const match = m.content.match(/data-salon-id="([^"]+)"/);
        if (match) return match[1];
      }
    }
    return null;
  }

  // Resolve booking id and salon id from conversation (last data-booking-id in assistant messages)
  _getBookingIdFromHistory(historyMessages) {
    if (!Array.isArray(historyMessages)) return null;
    for (let i = historyMessages.length - 1; i >= 0; i--) {
      const m = historyMessages[i];
      if (m?.role === 'assistant' && typeof m.content === 'string') {
        const match = m.content.match(/data-booking-id="([^"]+)"/);
        if (match) return match[1];
      }
    }
    return null;
  }

  // Extract salon_id from the first booking in the last assistant message that showed bookings
  _getSalonIdFromBookingHistory(historyMessages) {
    if (!Array.isArray(historyMessages)) return null;
    // Look for the last assistant message that contains booking cards
    for (let i = historyMessages.length - 1; i >= 0; i--) {
      const m = historyMessages[i];
      if (m?.role === 'assistant' && typeof m.content === 'string') {
        // Try to extract salon_id from metadata if available
        if (m.metadata && m.metadata.lastBookingData) {
          const bookings = Array.isArray(m.metadata.lastBookingData) ? m.metadata.lastBookingData : [];
          if (bookings.length > 0) {
            const firstBooking = bookings[0];
            return firstBooking.salon_id || firstBooking.salons?.id || null;
          }
        }
        // Fallback: try to parse from HTML cards (less reliable)
        const bookingMatch = m.content.match(/data-booking-id="([^"]+)"/);
        if (bookingMatch) {
          // We have a booking ID but need salon_id - this is a limitation
          // The AI should have access to salon_id from the booking data it received
          return null;
        }
      }
    }
    return null;
  }

  // When the user asked about a booking's location/address but the AI failed:
  // extract salon_id from booking history, fetch salon details, return location
  async _bookingLocationFallback(historyMessages, message, userContext, userId, userToken, allFunctionResponses = []) {
    const lang = userContext?.language === 'nl';
    const isLocation = /\b(location|address|locatie|adres|waar is|where is|geef mij de locatie|give me the location)\b/i.test(message);
    if (!isLocation) return null;

    let salonId = null;
    
    // First, try to get salon_id from function responses (most reliable)
    if (allFunctionResponses && allFunctionResponses.length > 0) {
      for (let i = allFunctionResponses.length - 1; i >= 0; i--) {
        const funcResp = allFunctionResponses[i];
        const responseData = funcResp?.functionResponse?.response?.data;
        if (responseData) {
          // Check if this is booking data
          let bookings = [];
          if (Array.isArray(responseData)) {
            bookings = responseData;
          } else if (responseData.data?.bookings && Array.isArray(responseData.data.bookings)) {
            bookings = responseData.data.bookings;
          } else if (responseData.bookings && Array.isArray(responseData.bookings)) {
            bookings = responseData.bookings;
          }
          
          if (bookings.length > 0) {
            // Get salon_id from first booking
            const firstBooking = bookings[0];
            salonId = firstBooking.salon_id || firstBooking.salons?.id || (firstBooking.salon ? firstBooking.salon.id : null);
            if (salonId) break;
          }
        }
      }
    }
    
    // Fallback: try to extract from history metadata
    if (!salonId) {
      salonId = this._getSalonIdFromBookingHistory(historyMessages);
    }
    
    if (!salonId) return null;

    try {
      // Get salon details for address
      const salonRes = await this.makeApiRequest(userId, userToken, 'GET', `/api/salons/${salonId}`, null, {});
      const salon = salonRes?.data?.data || salonRes?.data;
      if (!salon) return null;

      const addr = [salon.address, salon.city, salon.zip_code].filter(Boolean).join(', ') || (lang ? 'Adres niet beschikbaar' : 'Address not available');
      const lat = salon.latitude;
      const lng = salon.longitude;
      const mapsUrl = (lat != null && lng != null)
        ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
        : (salon.address || salon.city ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(salon.address || salon.city || '')}` : null);
      const link = mapsUrl ? `<a href="${mapsUrl}">${lang ? 'Open in Google Maps' : 'Open in Google Maps'}</a>` : '';
      
      const salonName = salon.business_name || 'Salon';
      
      return `<output><p><strong>${salonName}</strong></p><p>${addr}</p>${link}</output>`;
    } catch (e) {
      console.error('Error in booking location fallback:', e);
      return null;
    }
  }

  // When the user asks "Do I have a salon?" / "Heb ik een salon?" (ownership), answer from context — never return appointments.
  async _doIHaveASalonFallback(message, userContext, userId, userToken) {
    const isOwnershipAsk = /\b(do I have|heb ik)\s+(a |een )?(salon|slaon)\b/i.test(message) ||
      /\b(do I own|have I (got|registered))\s+a salon\b/i.test(message) ||
      /\bheb ik een salon\b/i.test(message);
    if (!isOwnershipAsk) return null;

    const lang = userContext?.language === 'nl';
    if (userContext?.mySalonId) {
      try {
        const salonRes = await this.makeApiRequest(userId, userToken, 'GET', '/api/salons/my/salon', null, {});
        const salon = salonRes?.data?.data?.salon || salonRes?.data?.salon;
        const name = salon?.business_name || (lang ? 'Je salon' : 'Your salon');
        return lang
          ? `<output><p>Ja, je hebt een salon geregistreerd: <strong>${name}</strong>.</p></output>`
          : `<output><p>Yes, you have a salon registered: <strong>${name}</strong>.</p></output>`;
      } catch (e) {
        return lang
          ? `<output><p>Ja, je hebt een salon geregistreerd.</p></output>`
          : `<output><p>Yes, you have a salon registered.</p></output>`;
      }
    }
    return lang
      ? `<output><p>Nee, je hebt geen salon geregistreerd. Je kunt er een aanmaken in de app.</p></output>`
      : `<output><p>No, you don't have a salon registered. You can create one in the app.</p></output>`;
  }

  // When a salon owner asks "where is it" / "waar is het" / "where is my salon" — get their salon from DB and return address (no need to ask "which salon?").
  async _mySalonLocationFallback(message, userContext, userId, userToken) {
    if (!userContext?.mySalonId) return null;
    const isLocationAsk = /\b(where is it|waar is het|where is my salon|waar is mijn salon|location of my salon|address of my salon|locatie van mijn salon|adres van mijn salon)\b/i.test(message.trim());
    if (!isLocationAsk) return null;

    try {
      const salonRes = await this.makeApiRequest(userId, userToken, 'GET', '/api/salons/my/salon', null, {});
      const salon = salonRes?.data?.data?.salon || salonRes?.data?.salon;
      if (!salon) return null;

      const lang = userContext?.language === 'nl';
      const addr = [salon.address, salon.city, salon.zip_code].filter(Boolean).join(', ') || (lang ? 'Adres niet beschikbaar' : 'Address not available');
      const lat = salon.latitude;
      const lng = salon.longitude;
      const mapsUrl = (lat != null && lng != null)
        ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
        : (salon.address || salon.city ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(salon.address || salon.city || '')}` : null);
      const link = mapsUrl ? `<a href="${mapsUrl}">${lang ? 'Open in Google Maps' : 'Open in Google Maps'}</a>` : '';
      const salonName = salon.business_name || (lang ? 'Je salon' : 'Your salon');

      return `<output><p><strong>${salonName}</strong></p><p>${addr}</p>${link}</output>`;
    } catch (e) {
      console.error('Error in my salon location fallback:', e);
      return null;
    }
  }

  // When the user asked about payment status for a booking but the AI failed:
  // extract booking_id from history, fetch payment status, return Yes/No answer
  async _paymentStatusFallback(historyMessages, message, userContext, userId, userToken, allFunctionResponses = []) {
    // Detect language from message itself (user writes in Dutch = respond in Dutch)
    const messageIsDutch = /\b(vandaag|boekingen|betaling|succesvol|geannuleerd|afspraak|heb|heeft|mijn|voor|de|het)\b/i.test(message);
    const lang = userContext?.language === 'nl' || messageIsDutch;
    const isPayment = /\b(payment|paid|successful|success|status|check if.*payment|was.*successful|yes or no|tech status|did.*fail|payment.*tech|payment.*status|fail.*payment|check.*successful.*payment|successful.*payment)\b/i.test(message);
    if (!isPayment) return null;

    const m = message.toLowerCase();
    const isToday = /\btoday\b|vandaag/i.test(m);
    const isYesterday = /\byesterday\b|gisteren/i.test(m);
    const todayStr = new Date().toISOString().slice(0, 10);
    const yesterdayStr = isYesterday ? new Date(Date.now() - 864e5).toISOString().slice(0, 10) : null;
    const isSuccessfulOnly = /\bsuccessful.*payment|successful.*paid|check.*successful/i.test(m);
    
    let bookingId = null;
    let targetBooking = null;
    let allBookings = [];
    
    // First, try to get booking_id from function responses (most reliable)
    if (allFunctionResponses && allFunctionResponses.length > 0) {
      for (let i = allFunctionResponses.length - 1; i >= 0; i--) {
        const funcResp = allFunctionResponses[i];
        const responseData = funcResp?.functionResponse?.response?.data;
        if (responseData) {
          // Check if this is booking data
          let bookings = [];
          if (Array.isArray(responseData)) {
            bookings = responseData;
          } else if (responseData.data?.bookings && Array.isArray(responseData.data.bookings)) {
            bookings = responseData.data.bookings;
          } else if (responseData.bookings && Array.isArray(responseData.bookings)) {
            bookings = responseData.bookings;
          }
          
          if (bookings.length > 0) {
            allBookings = bookings;
            // If user asked about "today", filter to today
            if (isToday) {
              const todayBookings = bookings.filter(b => {
                const date = b.appointment_date || b.appointmentDate || '';
                return date === todayStr;
              });
              if (todayBookings.length > 0) {
                targetBooking = todayBookings[0];
              }
            } else if (isYesterday && yesterdayStr) {
              targetBooking = bookings.find(b => {
                const date = b.appointment_date || b.appointmentDate || '';
                return date === yesterdayStr;
              });
            } else {
              // Otherwise get first booking (most recent)
              targetBooking = bookings[0];
            }
            
            if (targetBooking) {
              bookingId = targetBooking.id || targetBooking.booking_id;
              if (bookingId) break;
            }
          }
        }
      }
    }
    
    // If we need to fetch bookings (for "today" or "successful payments today")
    if ((isToday || isSuccessfulOnly) && allBookings.length === 0) {
      try {
        // Fetch both upcoming and past to catch all today's bookings
        const [upcomingRes, pastRes] = await Promise.all([
          this.makeApiRequest(userId, userToken, 'GET', '/api/bookings', null, { upcoming: 'true', limit: '100' }),
          this.makeApiRequest(userId, userToken, 'GET', '/api/bookings', null, { upcoming: 'false', limit: '100' })
        ]);
        const upcomingBookings = upcomingRes?.data?.data?.bookings || upcomingRes?.data?.bookings || [];
        const pastBookings = pastRes?.data?.data?.bookings || pastRes?.data?.bookings || [];
        allBookings = [...upcomingBookings, ...pastBookings];
        
        if (isToday) {
          const todayBookings = allBookings.filter(b => {
            const date = b.appointment_date || b.appointmentDate || '';
            return date === todayStr;
          });
          if (todayBookings.length > 0) {
            targetBooking = todayBookings[0];
            bookingId = targetBooking.id || targetBooking.booking_id;
          }
        } else if (allBookings.length > 0) {
          targetBooking = allBookings[0];
          bookingId = targetBooking.id || targetBooking.booking_id;
        }
      } catch (e) {
        console.error('Error fetching bookings for payment status:', e);
      }
    }
    
    // If we still don't have a booking and user asked about yesterday, fetch bookings
    if (!bookingId && isYesterday) {
      try {
        const bookingsRes = await this.makeApiRequest(userId, userToken, 'GET', '/api/bookings', null, { upcoming: 'false', limit: '100' });
        const bookings = bookingsRes?.data?.data?.bookings || bookingsRes?.data?.bookings || [];
        if (Array.isArray(bookings) && bookings.length > 0) {
          targetBooking = bookings.find(b => {
            const date = b.appointment_date || b.appointmentDate || '';
            return date === yesterdayStr;
          });
          if (targetBooking) {
            bookingId = targetBooking.id || targetBooking.booking_id;
          }
        }
      } catch (e) {
        console.error('Error fetching bookings for payment status:', e);
      }
    }
    
    // Fallback: try to extract from history
    if (!bookingId) {
      bookingId = this._getBookingIdFromHistory(historyMessages);
    }

    try {
      // Get payment history
      const paymentRes = await this.makeApiRequest(userId, userToken, 'GET', '/api/payments/history', null, {});
      const payments = paymentRes?.data?.data?.payments || paymentRes?.data?.payments || [];
      
      if (!Array.isArray(payments)) return null;
      
      // If user asked for "successful payments today", return all successful payments for today's bookings
      if (isSuccessfulOnly && isToday && allBookings.length > 0) {
        const todayBookings = allBookings.filter(b => {
          const date = b.appointment_date || b.appointmentDate || '';
          return date === todayStr;
        });
        
        const successfulPayments = [];
        for (const booking of todayBookings) {
          const bid = booking.id || booking.booking_id;
          const payment = payments.find(p => p.booking_id === bid);
          if (payment && (payment.status === 'completed' || payment.status === 'succeeded' || payment.status === 'paid')) {
            successfulPayments.push({ booking, payment });
          }
        }
        
        if (successfulPayments.length === 0) {
          return lang
            ? `<output><p>Je hebt vandaag geen succesvolle betalingen gevonden.</p></output>`
            : `<output><p>I found no successful payments for your bookings today.</p></output>`;
        }
        
        const total = successfulPayments.reduce((sum, sp) => sum + (Number(sp.payment.amount) || 0), 0);
        const cards = successfulPayments.map(({ booking, payment }) => {
          const salonName = booking.salons?.business_name || booking.salon?.business_name || booking.salonName || 'Salon';
          const serviceName = booking.services?.name || booking.service?.name || booking.serviceName || 'Service';
          const date = booking.appointment_date || booking.appointmentDate || '';
          const time = (booking.start_time || booking.startTime || '').toString().slice(0, 5);
          const amount = payment.amount != null ? `€${Number(payment.amount).toFixed(2)}` : '';
          const bookingId = booking.id || '';
          return `<div class="ai-card" data-booking-id="${bookingId}" style="padding:16px;margin:8px 0;border:1px solid #e0e0e0;border-radius:8px;cursor:pointer;"><h3 style="margin:0 0 8px 0;font-size:16px;font-weight:600;">${salonName}</h3><p style="margin:4px 0;color:#666;font-size:14px;">${serviceName}</p><p style="margin:4px 0;color:#666;font-size:14px;">${date} ${time}</p><p style="margin:4px 0;color:#22c55e;font-size:14px;font-weight:600;">✓ Paid: ${amount}</p></div>`;
        }).join('');
        
        return lang
          ? `<output><p>Ik heb ${successfulPayments.length} succesvolle betaling(en) gevonden voor vandaag, totaal €${total.toFixed(2)}:</p>${cards}</output>`
          : `<output><p>I found ${successfulPayments.length} successful payment(s) for today, totaling €${total.toFixed(2)}:</p>${cards}</output>`;
      }
      
      // Single booking payment check
      if (!bookingId) return null;
      
      // Find payment for this booking
      const payment = payments.find(p => p.booking_id === bookingId);
      
      if (!payment) {
        return lang 
          ? `<output><p>Geen betaling gevonden voor deze boeking. De betaling is mogelijk nog niet verwerkt.</p></output>`
          : `<output><p>No payment found for this booking. The payment may not have been processed yet.</p></output>`;
      }
      
      const status = payment.status || 'pending';
      const isSuccessful = status === 'completed' || status === 'succeeded' || status === 'paid';
      const amount = payment.amount != null ? `€${Number(payment.amount).toFixed(2)}` : '';
      
      // Get booking details for context
      const salonName = targetBooking?.salons?.business_name || targetBooking?.salon?.business_name || targetBooking?.salonName || 'Salon';
      const serviceName = targetBooking?.services?.name || targetBooking?.service?.name || targetBooking?.serviceName || 'Service';
      const bookingDate = targetBooking?.appointment_date || targetBooking?.appointmentDate || '';
      const bookingTime = (targetBooking?.start_time || targetBooking?.startTime || '').toString().slice(0, 5);
      
      if (isSuccessful) {
        return lang
          ? `<output><p>Ja! Je betaling voor ${salonName}${bookingDate ? ` op ${bookingDate}` : ''}${bookingTime ? ` om ${bookingTime}` : ''} is succesvol afgerond${amount ? ` (${amount})` : ''}.</p></output>`
          : `<output><p>Yes! Your payment for ${salonName}${bookingDate ? ` on ${bookingDate}` : ''}${bookingTime ? ` at ${bookingTime}` : ''} went through successfully${amount ? ` (${amount})` : ''}.</p></output>`;
      } else if (status === 'pending') {
        return lang
          ? `<output><p>De betaling voor je boeking bij ${salonName}${bookingDate ? ` op ${bookingDate}` : ''} is nog in behandeling. Het kan even duren voordat dit wordt verwerkt.</p></output>`
          : `<output><p>The payment for your booking at ${salonName}${bookingDate ? ` on ${bookingDate}` : ''} is still being processed. It may take a moment to complete.</p></output>`;
      } else {
        return lang
          ? `<output><p>Helaas is de betaling voor je boeking bij ${salonName}${bookingDate ? ` op ${bookingDate}` : ''} mislukt. Wil je dat ik je help om het opnieuw te proberen?</p></output>`
          : `<output><p>Unfortunately, the payment for your booking at ${salonName}${bookingDate ? ` on ${bookingDate}` : ''} failed. Would you like me to help you try again?</p></output>`;
      }
    } catch (e) {
      console.error('Error in payment status fallback:', e);
      return null;
    }
  }

  // When the user asked for one thing about one salon (picture, location, maps, services) but the AI failed:
  // fetch and return HTML. historyMessages from conversation.
  async _oneSalonDetailFallback(historyMessages, message, userContext, userId, userToken) {
    const salonId = this._getSalonIdFromHistory(historyMessages);
    if (!salonId) return null;
    const lang = userContext?.language === 'nl';
    const isImage = /\b(picture|image|photo)\b|where is the picture/i.test(message);
    const isServices = /\bservices\b|their services|what services|show me their services|what do they offer/i.test(message);

    if (isServices) {
      try {
        const res = await this.makeApiRequest(userId, userToken, 'GET', `/api/salons/${salonId}/services`, null, {});
        const list = res?.data?.data || res?.data || [];
        if (!Array.isArray(list)) return null;
        const cards = list.slice(0, 20).map(s => {
          const name = s.name || 'Service';
          const price = s.price != null ? ` · €${Number(s.price)}` : '';
          const dur = s.duration != null ? ` · ${s.duration} min` : '';
          return `<div class="ai-card" data-salon-id="${salonId}" data-service-id="${s.id || ''}" style="padding:12px;margin:8px 0;border:1px solid #e0e0e0;border-radius:8px;cursor:pointer;">${name}${price}${dur}</div>`;
        }).join('');
        const head = lang ? 'Diensten:' : 'Services:';
        return `<output><p style="margin-bottom:12px;font-weight:600;">${head}</p>${cards || (lang ? 'Geen diensten gevonden.' : 'No services found.')}</output>`;
      } catch (e) { return null; }
    }

    let res;
    try {
      res = await this.makeApiRequest(userId, userToken, 'GET', `/api/salons/${salonId}`, null, {});
    } catch (e) { return null; }
    const salon = res?.data?.data || res?.data;
    if (!salon) return null;
    if (isImage) {
      const url = Array.isArray(salon.images) && salon.images[0] ? salon.images[0] : (typeof salon.images === 'string' ? salon.images : null);
      if (url) {
        return `<output><p><strong>${salon.business_name || 'Salon'}</strong></p><img class="ai-image" src="${url}" alt="${(salon.business_name || 'Salon').replace(/"/g, '&quot;')}" style="max-width:100%;border-radius:8px;" /></output>`;
      }
      return `<output><p>${salon.business_name || 'Salon'}: ${lang ? 'Geen afbeelding beschikbaar.' : 'No image available.'}</p></output>`;
    }
    // location, address, maps, map, navigate, "show me in maps", "in a map"
    const addr = [salon.address, salon.city, salon.zip_code].filter(Boolean).join(', ') || (lang ? 'Adres niet beschikbaar' : 'Address not available');
    const lat = salon.latitude; const lng = salon.longitude;
    const mapsUrl = (lat != null && lng != null)
      ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
      : (salon.address || salon.city ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(salon.address || salon.city || '')}` : null);
    const link = mapsUrl ? `<a href="${mapsUrl}">${lang ? 'Open in Google Maps' : 'Open in Google Maps'}</a>` : '';
    return `<output><p><strong>${salon.business_name || 'Salon'}</strong></p><p>${addr}</p>${link}</output>`;
  }

  // When the user asked about their appointments/bookings (today, tomorrow, past, etc.) but the AI failed.
  async _bookingsFallback(message, userContext, userId, userToken) {
    const m = message.toLowerCase();
    const todayStr = new Date().toISOString().slice(0, 10);
    const tomorrowStr = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const yesterdayStr = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const isToday = /\btoday\b|vandaag|today\'s|\btonight\b/i.test(m);
    const isTomorrow = /\btomorrow\b|morgen/i.test(m);
    const isYesterday = /\byesterday\b|gisteren/i.test(m);
    const isPast = /\b(past|older|last time|history|previous|when was the last|when did I|my last|bookings?\s*history|past\s*bookings?|older\s*bookings?|all\s*older)\b/i.test(m);
    const upcoming = (isYesterday || isPast) ? 'false' : 'true';
    // Detect language from message itself (user writes in Dutch = respond in Dutch)
    const messageIsDutch = /\b(vandaag|boekingen|afspraken|geannuleerd|heb|heeft|mijn|voor|de|het|planning)\b/i.test(message);
    const lang = userContext?.language === 'nl' || messageIsDutch;
    try {
      let list = [];
      
      // For "today", fetch both upcoming and past to catch all bookings
      if (isToday) {
        const [upcomingRes, pastRes] = await Promise.all([
          this.makeApiRequest(userId, userToken, 'GET', '/api/bookings', null, { upcoming: 'true', limit: '100' }),
          this.makeApiRequest(userId, userToken, 'GET', '/api/bookings', null, { upcoming: 'false', limit: '100' })
        ]);
        const upcomingBookings = upcomingRes?.data?.data?.bookings || upcomingRes?.data?.bookings || [];
        const pastBookings = pastRes?.data?.data?.bookings || pastRes?.data?.bookings || [];
        const allBookings = [...upcomingBookings, ...pastBookings];
        list = allBookings.filter(b => (b.appointment_date || b.appointmentDate || '') === todayStr);
      } else {
        const res = await this.makeApiRequest(userId, userToken, 'GET', '/api/bookings', null, { upcoming, limit: '100' });
        const raw = res?.data?.data?.bookings || res?.data?.bookings || [];
        list = Array.isArray(raw) ? raw : [];
        if (isTomorrow) list = list.filter(b => (b.appointment_date || b.appointmentDate || '') === tomorrowStr);
        else if (isYesterday) list = list.filter(b => (b.appointment_date || b.appointmentDate || '') === yesterdayStr);
        // isPast: show all recent past (no date filter)
      }
      
      if (list.length === 0) {
        const msg = isToday ? (lang ? 'Je hebt vandaag geen afspraken.' : 'You have no appointments today.')
          : isTomorrow ? (lang ? 'Je hebt morgen geen afspraken.' : 'You have no appointments tomorrow.')
          : isYesterday ? (lang ? 'Je had gisteren geen afspraken.' : 'You had no appointments yesterday.')
          : isPast ? (lang ? 'Je hebt geen eerdere afspraken in je geschiedenis.' : 'You have no past appointments in your history.')
          : (lang ? 'Je hebt geen aanstaande afspraken.' : 'You have no upcoming appointments.');
        return `<output><p>${msg}</p></output>`;
      }
      const now = new Date();
      const sep = lang ? ' om ' : ' at ';
      const cards = list.slice(0, 50).map(b => {
        const salonName = b.salons?.business_name || b.salon?.business_name || b.salonName || 'Salon';
        const serviceName = b.services?.name || b.service?.name || b.serviceName || 'Service';
        const date = b.appointment_date || b.appointmentDate || '';
        const time = (b.start_time || b.startTime || '').toString().slice(0, 5);
        const bookingId = b.id || '';
        const status = b.status || '';
        const dt = date && time ? new Date(date + 'T' + time + ':00') : null;
        const isUpcoming = dt ? dt >= now : false;
        const isCancelled = status === 'cancelled';
        const dataAttrs = `data-booking-id="${bookingId}" data-booking-status="${status}" data-is-upcoming="${isUpcoming}" data-is-cancelled="${isCancelled}"`;
        const label = isCancelled ? (lang ? ' (Geannuleerd)' : ' (Cancelled)') : (isUpcoming ? '' : (lang ? ' (Afgelopen)' : ' (Past)'));
        return `<div class="ai-card" ${dataAttrs} style="padding:16px;margin:8px 0;border:1px solid #e0e0e0;border-radius:8px;cursor:pointer;"><h3 style="margin:0 0 8px 0;font-size:16px;font-weight:600;">${salonName}${label}</h3><p style="margin:4px 0;color:#666;font-size:14px;">${serviceName}</p><p style="margin:4px 0;color:#666;font-size:14px;">${date}${sep}${time}</p></div>`;
      }).join('');
      const head = isPast
        ? (lang ? `Je had ${list.length} eerdere afspraak/afspraken:` : `You had ${list.length} past appointment(s):`)
        : (lang ? `Je hebt ${list.length} afspraak/afspraken:` : `You have ${list.length} appointment(s):`);
      return `<output><p style="margin-bottom:16px;font-size:16px;font-weight:600;">${head}</p>${cards}</output>`;
    } catch (e) { return null; }
  }

  // When the user asked about sales/analytics but the AI failed:
  // fetch bookings and payments to calculate sales
  async _salesAnalyticsFallback(message, userContext, userId, userToken) {
    // Detect language from message itself (user writes in Dutch = respond in Dutch)
    const messageIsDutch = /\b(analyseer|vandaag|boekingen|omzet|winst|verdiend|heb|heeft|mijn|voor|salon eigenaar)\b/i.test(message);
    const lang = userContext?.language === 'nl' || messageIsDutch;
    const m = message.toLowerCase();
    const isSales = /\b(sales|revenue|analytics|analyze|analyse|omzet|winst|how much.*make|how much.*earn|verdiend|earned|earnings|gekregen)\b/i.test(m) ||
      /mijn salon|hoeveel.*(mijn )?salon|salon.*(vandag|gekregen|omzet|earned)/i.test(m);
    if (!isSales) return null;

    const isToday = /\btoday\b|vandaag|vandag/i.test(m);
    const todayStr = new Date().toISOString().slice(0, 10);
    
    try {
      // For salon owners, try analytics API first
      if (userContext?.user_type === 'salon_owner') {
        try {
          const analyticsRes = await this.makeApiRequest(userId, userToken, 'GET', '/api/analytics', null, {});
          const analytics = analyticsRes?.data?.data || analyticsRes?.data || {};
          
          if (analytics.revenue) {
            const total = analytics.revenue.total || 0;
            const count = analytics.revenue.count || 0;
            const currency = analytics.revenue.currency || 'EUR';
            
            if (isToday && analytics.revenue.timeline) {
              const todayRevenue = analytics.revenue.timeline.find(t => t.date === todayStr);
              if (todayRevenue) {
                return lang
                  ? `<output><p>Je hebt vandaag €${Number(todayRevenue.value).toFixed(2)} verdiend uit ${count} boeking(en).</p></output>`
                  : `<output><p>Your sales for today are €${Number(todayRevenue.value).toFixed(2)} from ${count} booking(s).</p></output>`;
              }
            }
            
            return lang
              ? `<output><p>Je totale omzet is €${Number(total).toFixed(2)} uit ${count} boeking(en).</p></output>`
              : `<output><p>Your total revenue is €${Number(total).toFixed(2)} from ${count} booking(s).</p></output>`;
          }
        } catch (e) {
          console.error('Error fetching analytics:', e);
          // Fall through to bookings/payments calculation
        }
      }
      
      // Fallback: Calculate from bookings and payments
      const [upcomingRes, pastRes] = await Promise.all([
        this.makeApiRequest(userId, userToken, 'GET', '/api/bookings', null, { upcoming: 'true', limit: '100' }),
        this.makeApiRequest(userId, userToken, 'GET', '/api/bookings', null, { upcoming: 'false', limit: '100' })
      ]);
      const upcomingBookings = upcomingRes?.data?.data?.bookings || upcomingRes?.data?.bookings || [];
      const pastBookings = pastRes?.data?.data?.bookings || pastRes?.data?.bookings || [];
      const allBookings = [...upcomingBookings, ...pastBookings];
      
      // Filter to today if requested
      let relevantBookings = allBookings;
      if (isToday) {
        relevantBookings = allBookings.filter(b => {
          const date = b.appointment_date || b.appointmentDate || '';
          return date === todayStr;
        });
      }
      
      // Get payment history
      const paymentRes = await this.makeApiRequest(userId, userToken, 'GET', '/api/payments/history', null, {});
      const payments = paymentRes?.data?.data?.payments || paymentRes?.data?.payments || [];
      
      if (!Array.isArray(payments)) {
        return lang
          ? `<output><p>Ik kan je omzet niet berekenen omdat er geen betalingsgegevens beschikbaar zijn.</p></output>`
          : `<output><p>I cannot calculate your sales because payment data is not available.</p></output>`;
      }
      
      // Calculate revenue from successful payments for relevant bookings
      let totalRevenue = 0;
      let successfulCount = 0;
      const bookingIds = relevantBookings.map(b => b.id || b.booking_id).filter(Boolean);
      
      for (const payment of payments) {
        if (bookingIds.includes(payment.booking_id)) {
          const status = payment.status || 'pending';
          if (status === 'completed' || status === 'succeeded' || status === 'paid') {
            totalRevenue += Number(payment.amount) || 0;
            successfulCount++;
          }
        }
      }
      
      if (isToday) {
        return lang
          ? `<output><p>Je hebt vandaag €${totalRevenue.toFixed(2)} verdiend uit ${successfulCount} succesvolle betaling(en).</p></output>`
          : `<output><p>Your sales for today are €${totalRevenue.toFixed(2)} from ${successfulCount} successful payment(s).</p></output>`;
      } else {
        return lang
          ? `<output><p>Je totale omzet is €${totalRevenue.toFixed(2)} uit ${successfulCount} succesvolle betaling(en).</p></output>`
          : `<output><p>Your total revenue is €${totalRevenue.toFixed(2)} from ${successfulCount} successful payment(s).</p></output>`;
      }
    } catch (e) {
      console.error('Error in sales analytics fallback:', e);
      return null;
    }
  }

  // Make authenticated API request on behalf of user
  async makeApiRequest(userId, userToken, method, endpoint, body = null, queryParams = {}) {
    try {
      const baseUrl = config.server.api_base_url || 'http://localhost:3000';
      const url = new URL(endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`);
      
      // Add query parameters
      Object.keys(queryParams).forEach(key => {
        if (queryParams[key] != null) {
          url.searchParams.append(key, queryParams[key]);
        }
      });

      const options = {
        method: method.toUpperCase(),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${userToken}`,
        },
      };

      return new Promise((resolve, reject) => {
        const requestModule = url.protocol === 'https:' ? https : http;
        const req = requestModule.request(url, options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve({
                status: res.statusCode,
                data: parsed,
                success: res.statusCode >= 200 && res.statusCode < 300
              });
            } catch (e) {
              resolve({
                status: res.statusCode,
                data: data,
                success: res.statusCode >= 200 && res.statusCode < 300
              });
            }
          });
        });

        req.on('error', (error) => {
          reject(error);
        });

        if (body && (method.toUpperCase() === 'POST' || method.toUpperCase() === 'PUT' || method.toUpperCase() === 'PATCH')) {
          req.write(JSON.stringify(body));
        }

        req.end();
      });
    } catch (error) {
      throw error;
    }
  }

  // Get function calling tools for Gemini
  getFunctionCallingTools(userContext = null) {
    // Gemini API v0.24.1 expects tools as an array
    const locationInfo = userContext?.location 
      ? `lat=${userContext.location.latitude}, lng=${userContext.location.longitude}` 
      : 'not provided';
    
    return [
      {
        functionDeclarations: [
          {
            name: 'make_api_request',
            description: `You have NO built-in knowledge of the user's bookings or calendar. For any question about their appointments, schedule, or "do I have X today"—realize you need data, call GET /api/bookings (upcoming "true"|"false", limit), then answer from the response. 

CRITICAL: When the user asks follow-up questions about appointments you just showed (e.g. "location of the first one", "geef mij de locatie voor de eerste", "waar is de eerste boeking"):
1. Extract the salon_id from the FIRST booking in your last response (or the specific position they mentioned like "second", "that one")
2. Call GET /api/salons/{salonId} to get address, city, zip_code, latitude, longitude
3. Provide the full address and a Google Maps link: <a href="https://www.google.com/maps/search/?api=1&query={lat},{lng}">Open in Google Maps</a>
4. Do NOT just repeat the booking list or say "I'm not sure what you need"

For time-based follow-ups like "what about yesterday?", "and tomorrow?", "other days?"—you need fresh data for that day/scope; call GET /api/bookings (upcoming=false for yesterday/past, true for tomorrow), then answer. Do not reply with a generic.

When the user wants to book or find a salon ("best", "top rated", "popular", "recommend"): call /api/salons/search with sort=rating and latitude/longitude (from Location), or /api/salons/popular. Do NOT say "I can't"—these exist. Always render salon and booking lists as HTML <output> with ai-card and data-salon-id or data-booking-id so the user can tap and act fast.

When the user asks for **one specific thing about one salon** you showed (picture, address, "open in maps", "their services"): resolve data-salon-id from the card, call GET /api/salons/{id} or GET /api/salons/{id}/services, fulfill the request, and do NOT re-list or reply with "How can I help you?"

Other: /api/bookings (upcoming, limit), /api/salons/nearby, /api/salons/search, /api/salons/{salonId}, /api/favorites, /api/services/categories. For follow-ups about items in lists you just showed, extract IDs from your last response and fetch details. Never raw JSON. Location: ${locationInfo}.`,
            parameters: {
              type: 'OBJECT',
              properties: {
                method: {
                  type: 'STRING',
                  description: 'HTTP method: GET, POST, PUT, PATCH, or DELETE',
                  enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
                },
                endpoint: {
                  type: 'STRING',
                  description: 'API path, e.g. /api/bookings, /api/favorites, /api/salons/nearby, /api/salons/popular, /api/services/categories. Set queryParams to match what the user asked: past/upcoming/all, limit for "all", lat/lng for nearby, q for search, etc.'
                },
                body: {
                  type: 'OBJECT',
                  description: 'Request body for POST/PUT/PATCH requests (optional)'
                },
                queryParams: {
                  type: 'OBJECT',
                  description: 'Query parameters as key-value pairs (optional)'
                }
              },
              required: ['method', 'endpoint']
            }
          }
        ]
      }
    ];
  }

  // Get user context for AI
  async getUserContext(userId, accessToken, latitude = null, longitude = null) {
    try {
      // Use authenticated client for RLS
      const client = accessToken ? getAuthenticatedClient(accessToken) : supabaseAdmin;
      
      // Get user profile
      const { data: userProfile, error: profileError } = await client
        .from('user_profiles')
        .select('id, first_name, last_name, language')
        .eq('id', userId)
        .single();

      // Get recent bookings (last 5)
      const { data: recentBookings } = await client
        .from('bookings')
        .select(`
          id,
          appointment_date,
          start_time,
          salons:salon_id(business_name, city)
        `)
        .eq('client_id', userId)
        .order('appointment_date', { ascending: false })
        .order('start_time', { ascending: false })
        .limit(5);

      // Get favorite salons
      const { data: favoriteSalons } = await client
        .from('user_favorites')
        .select(`
          salons:salon_id(business_name, city, rating_average)
        `)
        .eq('user_id', userId)
        .limit(10);

      // If user owns a salon (salon owner), get their salon id for "where is my salon" / "where is it" flows
      const { data: mySalon } = await client
        .from('salons')
        .select('id')
        .eq('owner_id', userId)
        .limit(1)
        .maybeSingle();

      return {
        userId: userId,
        name: userProfile ? `${userProfile.first_name} ${userProfile.last_name}` : null,
        language: userProfile?.language || 'en',
        recentBookings: recentBookings || [],
        favoriteSalons: favoriteSalons?.map(f => f.salons) || [],
        location: (latitude && longitude) ? { latitude, longitude } : null,
        mySalonId: mySalon?.id || null,
        user_type: mySalon ? 'salon_owner' : 'client'
      };
    } catch (error) {
      return {
        name: null,
        language: 'en',
        recentBookings: [],
        favoriteSalons: [],
        mySalonId: null,
        user_type: 'client'
      };
    }
  }

  // Get or create conversation
  getOrCreateConversation = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { conversationId } = req.body;
    const authenticatedClient = getAuthenticatedClient(req.token);

    if (conversationId) {
      // Get existing conversation
      const { data: conversation, error } = await authenticatedClient
        .from('ai_conversations')
        .select('*')
        .eq('id', conversationId)
        .eq('user_id', userId)
        .single();

      if (error || !conversation) {
        throw new AppError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
      }

      return res.json({
        success: true,
        conversation
      });
    }

    // Create new conversation
    const { data: conversation, error } = await authenticatedClient
      .from('ai_conversations')
      .insert({
        user_id: userId,
        title: 'New Conversation'
      })
      .select()
      .single();

    if (error) {
      throw new AppError('Failed to create conversation', 500, 'CREATE_CONVERSATION_ERROR');
    }

    res.json({
      success: true,
      conversation
    });
  });

  // Get all conversations for user
  getConversations = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { limit = 20, offset = 0 } = req.query;
    const authenticatedClient = getAuthenticatedClient(req.token);

    const { data: conversations, error } = await authenticatedClient
      .from('ai_conversations')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) {
      throw new AppError('Failed to fetch conversations', 500, 'FETCH_CONVERSATIONS_ERROR');
    }

    res.json({
      success: true,
      conversations: conversations || [],
      count: conversations?.length || 0
    });
  });

  // Get messages for a conversation
  getMessages = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const authenticatedClient = getAuthenticatedClient(req.token);

    // Verify conversation belongs to user
    const { data: conversation, error: convError } = await authenticatedClient
      .from('ai_conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .single();

    if (convError || !conversation) {
      throw new AppError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
    }

    const { data: messages, error } = await authenticatedClient
      .from('ai_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new AppError('Failed to fetch messages', 500, 'FETCH_MESSAGES_ERROR');
    }

    res.json({
      success: true,
      messages: messages || []
    });
  });

  // Send message to AI
  sendMessage = asyncHandler(async (req, res) => {
    if (!this.model) {
      throw new AppError('AI service is not available. GEMINI_API_KEY may not be set.', 503, 'AI_SERVICE_UNAVAILABLE');
    }

    const userId = req.user.id;
    const { conversationId, message, newConversation, latitude, longitude } = req.body;

    if (!message || message.trim().length === 0) {
      throw new AppError('Message is required', 400, 'MESSAGE_REQUIRED');
    }

    let currentConversationId = conversationId;

    // Use authenticated client for RLS
    const authenticatedClient = getAuthenticatedClient(req.token);
    
    // Get user context for storing in conversation
    const userContext = await this.getUserContext(userId, req.token, latitude, longitude);
    
    // Create new conversation if needed
    if (newConversation || !currentConversationId) {
      const { data: newConv, error: convError } = await authenticatedClient
        .from('ai_conversations')
        .insert({
          user_id: userId,
          title: message.substring(0, 50), // Use first 50 chars as title
          context: {
            name: userContext.name,
            language: userContext.language,
            location: userContext.location,
            recentBookingsCount: userContext.recentBookings?.length || 0,
            favoriteSalonsCount: userContext.favoriteSalons?.length || 0
          }
        })
        .select()
        .single();

      if (convError) {
        throw new AppError('Failed to create conversation', 500, 'CREATE_CONVERSATION_ERROR');
      }

      currentConversationId = newConv.id;
    } else {
      // Verify conversation belongs to user
      const { data: conversation, error: convError } = await authenticatedClient
        .from('ai_conversations')
        .select('id')
        .eq('id', currentConversationId)
        .eq('user_id', userId)
        .single();

      if (convError || !conversation) {
        throw new AppError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
      }
      
      // Update context in existing conversation
      await authenticatedClient
        .from('ai_conversations')
        .update({
          context: {
            name: userContext.name,
            language: userContext.language,
            location: userContext.location,
            recentBookingsCount: userContext.recentBookings?.length || 0,
            favoriteSalonsCount: userContext.favoriteSalons?.length || 0
          }
        })
        .eq('id', currentConversationId);
    }

    // Save user message
    const { data: userMessage, error: userMsgError } = await authenticatedClient
      .from('ai_messages')
      .insert({
        conversation_id: currentConversationId,
        role: 'user',
        content: message.trim()
      })
      .select()
      .single();

    if (userMsgError) {
      throw new AppError('Failed to save user message', 500, 'SAVE_MESSAGE_ERROR');
    }

    // Get conversation history (last N messages for context)
    // IMPORTANT: Load history AFTER saving user message so it includes the current message
    const { data: historyMessages, error: historyError } = await authenticatedClient
      .from('ai_messages')
      .select('role, content, created_at, metadata')
      .eq('conversation_id', currentConversationId)
      .order('created_at', { ascending: true })
      .limit(config.ai.max_conversation_history);

    // Log history for debugging
    if (historyError) {
      console.error(`❌ Error loading conversation history:`, historyError);
    }
    
    if (historyMessages && historyMessages.length > 0) {
      console.log(`📚 Loaded ${historyMessages.length} messages from history for conversation ${currentConversationId}`);
      // Log message breakdown
      const userMsgs = historyMessages.filter(m => m.role === 'user').length;
      const assistantMsgs = historyMessages.filter(m => m.role === 'assistant').length;
      console.log(`📚 History breakdown: ${userMsgs} user messages, ${assistantMsgs} assistant messages`);
      
      // Log a sample of recent messages for debugging
      if (historyMessages.length > 2) {
        const recent = historyMessages.slice(-4, -1); // Last 3 messages (excluding current)
        recent.forEach((msg, idx) => {
          console.log(`📚 History[${historyMessages.length - 3 + idx}]: ${msg.role} - ${msg.content.substring(0, 60)}...`);
        });
      }
    } else {
      console.log(`⚠️ No history found for conversation ${currentConversationId} - this is a new conversation`);
    }

    // User context already fetched above

    // Build chat history for Gemini
    const chatHistory = [];
    const systemPrompt = this.getSystemPrompt(userContext);

    // Add conversation history - EXCLUDE the current user message since we'll send it separately
    // The current user message is already saved, so we need to exclude it from history
    // and send it as the current message to Gemini
    if (historyMessages && historyMessages.length > 0) {
      // Filter out the most recent user message (the one we just saved)
      // We'll send it as the current message instead of including it in history
      const messagesToInclude = historyMessages.slice(0, -1); // Exclude last message (current user message)
      
      messagesToInclude.forEach(msg => {
        if (msg.role === 'user' || msg.role === 'assistant') {
          chatHistory.push({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
          });
        }
      });
      
      console.log(`📝 Added ${messagesToInclude.length} messages to chat history (excluded current user message)`);
      // Log first and last few messages for debugging
      if (messagesToInclude.length > 0) {
        console.log(`📝 First message: ${messagesToInclude[0].role} - ${messagesToInclude[0].content.substring(0, 50)}...`);
        if (messagesToInclude.length > 1) {
          console.log(`📝 Last message: ${messagesToInclude[messagesToInclude.length - 1].role} - ${messagesToInclude[messagesToInclude.length - 1].content.substring(0, 50)}...`);
        }
      }
    } else {
      console.log(`⚠️ No previous messages in conversation ${currentConversationId} - this is a new conversation`);
    }

    try {
      let chat;
      const userToken = req.token; // Get user's auth token
      
      const tools = this.getFunctionCallingTools(userContext);
      
      // Always prepend system prompt so the model keeps context (endpoints, rules, "never say I can't search")
      // Without it, in long conversations the model forgets and deflects or returns generic
      chatHistory.unshift({
        role: 'model',
        parts: [{ text: 'I understand. I have no built-in data on the user\'s bookings or appointments—for any question about those I will call GET /api/bookings first, then answer. For salons (best, top rated, recommend) I will call /api/salons/search or /api/salons/popular. I will show HTML <output> cards for lists. I will never say "I can\'t search" or reply with a generic when I can fetch.' }]
      });
      chatHistory.unshift({
        role: 'user',
        parts: [{ text: systemPrompt }]
      });
      console.log(`📝 Chat history: ${chatHistory.length} messages (including system prompt)`);
      
      console.log(`💬 Starting chat with ${chatHistory.length} messages in history`);
      
      // Start chat with tools and history
      chat = this.model.startChat({
        history: chatHistory,
        generationConfig: {
          maxOutputTokens: config.ai.max_tokens,
          temperature: config.ai.temperature,
        },
        tools: tools,
      });

      // Let the AI naturally understand user intent - no hardcoded keyword detection
      // The system prompt should guide the AI to use function calls when needed
      
      // Send the current user message to Gemini
      // Note: The current user message is NOT in chatHistory, we send it now
      console.log(`💬 Sending current message to Gemini: "${message.substring(0, 50)}..."`);
      let result = await chat.sendMessage(message.trim());
      let response = result.response;
      
      // Handle function calls - check both functionCalls and functionCall (singular)
      let currentFunctionCalls = response.functionCalls || (response.functionCall ? [response.functionCall] : []);
      let functionCallCount = 0;
      const maxFunctionCallIterations = 5; // Prevent infinite loops
      
      // Store functionResponses outside the loop so we can access it later
      let allFunctionResponses = [];
      
      // If there are function calls, ignore any initial text response - we'll get the final response after function calls complete
      let initialTextResponse = '';
      if (currentFunctionCalls.length > 0) {
        // Extract initial text but don't use it yet - wait for function calls to complete
        try {
          if (typeof response.text === 'function') {
            initialTextResponse = response.text();
          } else if (response.text) {
            initialTextResponse = response.text;
          }
        } catch (e) {
          // Ignore
        }
        console.log('🔍 Initial function calls detected:', currentFunctionCalls.length, '- Ignoring initial text response:', initialTextResponse.substring(0, 100));
      }
      
      console.log('🔍 Initial function calls:', currentFunctionCalls.length);

      while (currentFunctionCalls && currentFunctionCalls.length > 0 && functionCallCount < maxFunctionCallIterations) {
        functionCallCount++;
        console.log(`🔄 Function call iteration ${functionCallCount}, calls: ${currentFunctionCalls.length}`);
        const functionResponses = [];
        
        // Don't reset allFunctionResponses - we need to accumulate across iterations

        for (const functionCall of currentFunctionCalls) {
          if (functionCall.name === 'make_api_request') {
            try {
              const { method, endpoint, body, queryParams } = functionCall.args;
              const apiResponse = await this.makeApiRequest(
                userId,
                userToken,
                method,
                endpoint,
                body,
                queryParams || {}
              );

              functionResponses.push({
                functionResponse: {
                  name: 'make_api_request',
                  response: {
                    success: apiResponse.success,
                    status: apiResponse.status,
                    data: apiResponse.data
                  }
                }
              });
            } catch (error) {
              functionResponses.push({
                functionResponse: {
                  name: 'make_api_request',
                  response: {
                    success: false,
                    error: error.message
                  }
                }
              });
            }
          }
        }

        // Send function responses back to the model
        if (functionResponses.length > 0) {
          // Store all function responses for later use (accumulate across iterations)
          allFunctionResponses = [...allFunctionResponses, ...functionResponses];
          
          // Store the last function response data for HTML/UI generation
          const lastFunctionResponse = functionResponses[functionResponses.length - 1];
          const lastResponseData = lastFunctionResponse?.functionResponse?.response?.data;
          // Store for later use in follow-up prompts
          functionResponses._lastData = lastResponseData;
          
          console.log('📊 Function response received, data keys:', lastResponseData ? Object.keys(lastResponseData) : 'no data');
          
          result = await chat.sendMessage(functionResponses);
          response = result.response;
          // Update currentFunctionCalls for next iteration
          currentFunctionCalls = response.functionCalls || (response.functionCall ? [response.functionCall] : []);
          
          // If no more function calls, ensure HTML is generated
          if (currentFunctionCalls.length === 0 && lastResponseData) {
            // Check if response already has HTML
            const responseText = typeof response.text === 'function' ? response.text() : (response.text || '');
            const hasHTML = responseText.includes('<output>') || responseText.includes('<div class="ai-card"') || responseText.includes('ai-card');
            
            if (!hasHTML) {
              let dataArray = [];
              if (Array.isArray(lastResponseData)) {
                dataArray = lastResponseData;
              } else if (lastResponseData && typeof lastResponseData === 'object') {
                if (Array.isArray(lastResponseData.data?.bookings)) dataArray = lastResponseData.data.bookings;
                else if (Array.isArray(lastResponseData.data?.salons)) dataArray = lastResponseData.data.salons;
                else if (Array.isArray(lastResponseData.data)) dataArray = lastResponseData.data;
                else if (Array.isArray(lastResponseData.bookings)) dataArray = lastResponseData.bookings;
                else if (Array.isArray(lastResponseData.salons)) dataArray = lastResponseData.salons;
                else if (lastResponseData.success && Array.isArray(lastResponseData.data)) dataArray = lastResponseData.data;
              }
              const limitedData = (Array.isArray(dataArray) ? dataArray : []).slice(0, 10);
              const htmlPrompt = `The user asked: "${message}". You have this data: ${JSON.stringify(limitedData)}. Display it in HTML in <output> tags with ai-card elements. Use data-booking-id for bookings, data-salon-id for salons. Filter or format according to what the user asked.`;
              const htmlResult = await chat.sendMessage(htmlPrompt);
              const htmlResponse = htmlResult.response;
              if (typeof htmlResponse.text === 'function') {
                response.text = htmlResponse.text();
              } else if (htmlResponse.text) {
                response.text = htmlResponse.text;
              }
            }
          }
        } else {
          break; // No function responses to send, exit loop
        }
      }

      // Get text response - handle different response formats
      let aiResponse = '';

      // Try multiple ways to extract text from response
      if (!aiResponse) {
        try {
          if (typeof response.text === 'function') {
            aiResponse = response.text();
          } else if (response.text && typeof response.text === 'string') {
            aiResponse = response.text;
          }
        } catch (e) {
          // Continue to try other methods
        }
      }
      
      // Try candidates format
      if (!aiResponse && response.candidates && response.candidates.length > 0) {
        for (const candidate of response.candidates) {
          if (candidate.content && candidate.content.parts) {
            const textParts = candidate.content.parts
              .filter(part => part.text)
              .map(part => part.text);
            if (textParts.length > 0) {
              aiResponse = textParts.join('');
              break;
            }
          }
        }
      }
      
      // Try direct parts access
      if (!aiResponse && response.parts) {
        const textParts = response.parts
          .filter(part => part.text)
          .map(part => part.text);
        if (textParts.length > 0) {
          aiResponse = textParts.join('');
        }
      }

      // If the AI echoed raw API JSON instead of HTML, convert it to <output> cards
      if (aiResponse && !aiResponse.includes('<output>')) {
        const converted = this._convertRawJsonToHtml(aiResponse, message, userContext);
        if (converted) {
          aiResponse = converted;
          console.log('🔄 Converted raw JSON in AI response to HTML cards');
        }
      }
      
      // If we already generated HTML directly, skip generic response check
      if (aiResponse && aiResponse.includes('<output>')) {
        console.log('✅ Using directly generated HTML response, skipping generic check');
      } else {
        // If still no response after function calls, the model might need a follow-up
        // Also check if response is generic and needs context
        const responseLower = aiResponse.toLowerCase();
        const isGenericResponse = !aiResponse || aiResponse.trim().length === 0 || 
          (responseLower.includes('verwerkt') && !aiResponse.includes('<output>') && !aiResponse.includes('**')) ||
          (responseLower.includes('processed') && !aiResponse.includes('<output>') && !aiResponse.includes('**')) ||
          (responseLower.includes('hoe kan ik') && !aiResponse.includes('<output>') && !aiResponse.includes('**')) ||
          (responseLower.includes('how can i') && !aiResponse.includes('<output>') && !aiResponse.includes('**')) ||
          (responseLower.includes('hoe kan ik je verder helpen') && !aiResponse.includes('<output>') && !aiResponse.includes('**')) ||
          (responseLower.includes('how can i help you') && !aiResponse.includes('<output>') && !aiResponse.includes('**')) ||
          (responseLower.trim() === 'ik heb je verzoek verwerkt. hoe kan ik je verder helpen?' && !aiResponse.includes('<output>') && !aiResponse.includes('**'));
      
        console.log('🔍 Checking response:', {
        isGeneric: isGenericResponse,
        functionCallCount,
        responseLength: aiResponse.length,
        responsePreview: aiResponse.substring(0, 100),
        hasOutput: aiResponse.includes('<output>'),
        hasMarkdown: aiResponse.includes('**'),
        allFunctionResponsesCount: allFunctionResponses.length
      });
      
          // If we have function calls but got a generic response, log more details
          if (isGenericResponse && functionCallCount > 0) {
            console.log('⚠️ WARNING: Generic response detected after', functionCallCount, 'function call iterations');
            console.log('📦 Available function responses:', allFunctionResponses.length);
            if (allFunctionResponses.length > 0) {
              const lastResponse = allFunctionResponses[allFunctionResponses.length - 1];
              console.log('📦 Last function response structure:', JSON.stringify(Object.keys(lastResponse || {})).substring(0, 200));
            }
          }
          
          if (isGenericResponse && functionCallCount > 0) {
            // Function calls completed but response is generic - force display of data
            console.log('⚠️ Generic response detected after function calls, forcing data display');
            let responseData = null;
            let dataArray = [];
            
            try {
              // Get the actual data from function responses
              if (allFunctionResponses.length === 0) {
                console.error('❌ No function responses available for follow-up!');
                throw new Error('No function responses available');
              }
              const lastFunctionResponse = allFunctionResponses[allFunctionResponses.length - 1];
              responseData = lastFunctionResponse?.functionResponse?.response?.data;
              
              console.log('📦 Last function response data structure:', responseData ? (Array.isArray(responseData) ? `Array(${responseData.length})` : typeof responseData) : 'null');
              
              console.log('📦 Extracted response data:', responseData ? (Array.isArray(responseData) ? `Array(${responseData.length})` : Object.keys(responseData)) : 'null');
              
              // Handle different response structures (e.g. { data: { bookings, pagination } })
              if (responseData && typeof responseData === 'object') {
                if (responseData.data?.bookings && Array.isArray(responseData.data.bookings)) {
                  responseData = responseData.data.bookings;
                } else if (responseData.data && Array.isArray(responseData.data)) {
                  responseData = responseData.data;
                } else if (responseData.bookings && Array.isArray(responseData.bookings)) {
                  responseData = responseData.bookings;
                } else if (responseData.salons && Array.isArray(responseData.salons)) {
                  responseData = responseData.salons;
                } else if (responseData.success && responseData.data) {
                  const d = responseData.data;
                  responseData = (d && Array.isArray(d.bookings)) ? d.bookings : (Array.isArray(d) ? d : responseData);
                }
              }
              dataArray = Array.isArray(responseData) ? responseData : [];
              const limited = dataArray.slice(0, 10);
              const followUpPrompt = dataArray.length > 0
                ? `The user asked: "${message}". You have this data: ${JSON.stringify(limited)}. Display it in HTML in <output> tags with ai-card. Use data-booking-id for bookings, data-salon-id for salons. Match the user's intent (filter by date, type, etc. if they asked).`
                : (userContext?.language === 'nl' ? 'Je hebt geen data gevonden. Zeg dat duidelijk.' : 'No data found. Say so clearly.');
              console.log('🔄 Sending follow-up to force data display');
              
              const followUpResult = await chat.sendMessage(followUpPrompt);
              const followUpResponse = followUpResult.response;
              
              if (typeof followUpResponse.text === 'function') {
                aiResponse = followUpResponse.text();
              } else if (followUpResponse.text) {
                aiResponse = followUpResponse.text;
              } else if (followUpResponse.candidates && followUpResponse.candidates[0] && followUpResponse.candidates[0].content) {
                const parts = followUpResponse.candidates[0].content.parts || [];
                aiResponse = parts.map(part => part.text || '').join('');
              }
              
              console.log('✅ Follow-up response received:', aiResponse.substring(0, 200));
            } catch (e) {
              console.error('❌ Follow-up prompt failed:', e);
              if (dataArray.length > 0) {
                const isBooking = dataArray[0] && (dataArray[0].appointment_date != null || dataArray[0].start_time != null);
                const toShow = dataArray.slice(0, 10);
                if (isBooking) {
                  const cards = toShow.map(b => {
                    const name = b.salon?.business_name || b.salons?.business_name || b.salonName || 'Salon';
                    const time = (b.start_time || b.startTime || '').toString().slice(0, 5);
                    const bid = b.id || '';
                    return `<div class="ai-card" data-booking-id="${bid}" style="padding:12px;margin:8px 0;border:1px solid #e0e0e0;border-radius:8px;"><strong>${name}</strong> – ${time}</div>`;
                  }).join('');
                  aiResponse = `<output><p>${userContext?.language === 'nl' ? 'Gevonden:' : 'Found:'}</p>${cards}</output>`;
                } else {
                  const cards = toShow.map(it => {
                    const sid = it.salon_id || it.salons?.id || it.id;
                    const name = it.salons?.business_name || it.salon?.business_name || it.business_name || it.name || 'Item';
                    return `<div class="ai-card" data-salon-id="${sid || ''}" style="padding:12px;margin:8px 0;border:1px solid #e0e0e0;border-radius:8px;">${name}</div>`;
                  }).join('');
                  aiResponse = `<output><p>${userContext?.language === 'nl' ? 'Gevonden:' : 'Found:'}</p>${cards}</output>`;
                }
              } else {
                aiResponse = userContext?.language === 'nl' ? 'Geen gegevens gevonden.' : 'No data found.';
              }
            }
          } else if (!aiResponse || !String(aiResponse).trim()) {
            // If they asked about sales/analytics (check this first, before any other fallbacks)
            const isSalesQuery = /\b(sales|revenue|analytics|analyze|analyse|omzet|winst|how much.*make|how much.*earn|verdiend|earned|earnings|gekregen)\b/i.test(message) ||
              /mijn salon|hoeveel.*(mijn )?salon|salon.*(vandag|gekregen|omzet|earned)/i.test(message);
            if (isSalesQuery) {
              try {
                const salesHtml = await this._salesAnalyticsFallback(message, userContext, userId, userToken);
                if (salesHtml) {
                  aiResponse = salesHtml;
                }
              } catch (e) {
                console.error('Error in sales analytics fallback:', e);
              }
            }
            // If they asked for one thing about one salon (picture, location, maps, services), try that first
            if (!aiResponse && /\b(picture|image|photo|location|address|maps|map|navigate|services)\b|where is the picture|show me in maps|in a map|their services|what services|show me their services|what do they offer/i.test(message)) {
              try {
                // Salon owner asking "where is it" / "waar is het" without naming a salon → use their salon from DB
                if (userContext?.mySalonId && /\b(where is it|waar is het|where is my salon|waar is mijn salon)\b/i.test(message.trim())) {
                  const mySalonHtml = await this._mySalonLocationFallback(message, userContext, userId, userToken);
                  if (mySalonHtml) aiResponse = mySalonHtml;
                }
                if (!aiResponse) {
                const html = await this._oneSalonDetailFallback(historyMessages, message, userContext, userId, userToken);
                if (html) aiResponse = html;
                }
              } catch (e) {}
            }
            // If they asked about payment status (check this BEFORE bookings to handle combined queries)
            const isPaymentQuery = /\b(payment|paid|successful|success|status|check if.*payment|was.*successful|yes or no|tech status|did.*fail|payment.*tech|payment.*status)\b/i.test(message);
            if (!aiResponse && isPaymentQuery) {
              try {
                // Try payment status fallback - it will fetch bookings if needed
                const paymentHtml = await this._paymentStatusFallback(historyMessages, message, userContext, userId, userToken, allFunctionResponses);
                if (paymentHtml) {
                  aiResponse = paymentHtml;
                } else if (!aiResponse) {
                  // If payment fallback didn't work, try getting bookings first, then payment
                  const bookingsHtml = await this._bookingsFallback(message, userContext, userId, userToken);
                  if (bookingsHtml) {
                    // After getting bookings, try payment status again with updated function responses
                    const paymentHtml2 = await this._paymentStatusFallback(historyMessages, message, userContext, userId, userToken, allFunctionResponses);
                    if (paymentHtml2) {
                      // Combine: payment answer first, then booking details
                      aiResponse = paymentHtml2 + '\n\n' + bookingsHtml;
                    } else {
                      aiResponse = bookingsHtml;
                    }
                  }
                }
              } catch (e) {
                console.error('Error in payment status fallback:', e);
              }
            }
            // "Do I have a salon?" = ownership (do I own a salon?), NOT appointments — answer from context, never return bookings
            const isSalonOwnershipQuery = /\b(do I have|heb ik)\s+(a |een )?(salon|slaon)\b/i.test(message) ||
              /\b(do I own|have I (got|registered))\s+a salon\b/i.test(message) ||
              /\bheb ik een salon\b/i.test(message);
            if (!aiResponse && isSalonOwnershipQuery) {
              try {
                const ownershipHtml = await this._doIHaveASalonFallback(message, userContext, userId, userToken);
                if (ownershipHtml) aiResponse = ownershipHtml;
              } catch (e) {
                console.error('Error in do-I-have-a-salon fallback:', e);
              }
            }
            // If they asked about appointments/bookings (today, yesterday, past, "what about tomorrow", etc.), fetch and show
            // Only if NOT a payment query and NOT "do I have a salon?" (ownership)
            const isBookingQuery = !isPaymentQuery && !isSalonOwnershipQuery && (
              /\b(appointment|booking|bookings|plans|planning|agenda|schedule|afspraak|afspraken|boeking|boekingen)\b/i.test(message) ||
              /\b(do I have|heb ik|staat er|wat heb ik|heb ik.*iets|heb ik.*gepland|staat.*op.*planning|heb ik.*vandaag|heb ik.*morgen|heb ik.*gisteren)\b/i.test(message) ||
              /\b(when was the last time|last time I did|past booking|my history|booking history|older booking|older bookings|all older|tell me of older)\b/i.test(message) ||
              /\b(any (plans|appointment)|(my|any) (bookings|appointments))\b/i.test(message) ||
              /\b(what about|how about) (yesterday|tomorrow|other days)\b/i.test(message) ||
              /\bother days\b/i.test(message)
            );
            if (!aiResponse && isBookingQuery) {
              try {
                const html = await this._bookingsFallback(message, userContext, userId, userToken);
                if (html) aiResponse = html;
              } catch (e) {
                console.error('Error in bookings fallback:', e);
              }
            }
            // Else if they asked for salons (best, top rated, etc.) and we have nothing, fetch and show full list
            if (!aiResponse && /\b(best|top|rated|recommend|popular|efficient)\b/i.test(message)) {
              try {
                const loc = userContext?.location;
                const query = loc ? { sort: 'rating', latitude: String(loc.latitude), longitude: String(loc.longitude) } : {};
                const ep = Object.keys(query).length >= 3 ? '/api/salons/search' : '/api/salons/popular';
                const res = await this.makeApiRequest(userId, userToken, 'GET', ep, null, query);
                let arr = Array.isArray(res?.data) ? res.data : res?.data?.data || res?.data?.salons || [];
                if (arr.length > 0) {
                  const cards = arr.slice(0, 10).map(s => {
                    const sid = s.id || ''; const name = s.business_name || s.name || 'Salon';
                    const r = s.rating_average != null ? ` ${Number(s.rating_average).toFixed(1)}` : '';
                    return `<div class="ai-card" data-salon-id="${sid}" style="padding:12px;margin:8px 0;border:1px solid #e0e0e0;border-radius:8px;cursor:pointer;"><strong>${name}</strong>${r}</div>`;
                  }).join('');
                  const head = userContext?.language === 'nl' ? 'Top salons om te boeken:' : 'Top salons to book:';
                  aiResponse = `<output><p>${head}</p>${cards}</output>`;
                }
              } catch (e) { /* keep generic below */ }
            }
            // Status-check follow-up: user said "have u got anything?", "any luck?", etc. while last AI message said "one moment"/"fetching"
            // → treat as "show results for what I asked for" (e.g. past bookings) instead of generic fallback
            if (!aiResponse && historyMessages && historyMessages.length >= 2) {
              const lastAssistant = [...historyMessages].reverse().find(m => m.role === 'assistant');
              const lastContent = (lastAssistant && lastAssistant.content) ? String(lastAssistant.content) : '';
              const isStatusCheck = /\b(have u got anything|got anything|any luck|did you find|have you got|and\?|well\?|anything\?|any result|got it\?|any update|you got something|have u forgot the context|did you forget|remember what I asked|tell me of older)\b/i.test(message.trim());
              const lastSaidFetching = /(one moment|get that from the API|I need to get that information|checking|I need to fetch|let me get|I'll check|fetching|I should be checking your past)/i.test(lastContent);
              if (isStatusCheck && lastSaidFetching) {
                try {
                  const html = await this._bookingsFallback('past bookings', userContext, userId, userToken);
                  if (html) {
                    aiResponse = html;
                    console.log('🔄 Status-check follow-up: forced past bookings fallback (user asked for results after "one moment")');
                  }
                } catch (e) {
                  console.error('Error in status-check past-bookings fallback:', e);
                }
              }
            }
            if (!aiResponse || !String(aiResponse).trim()) {
              aiResponse = userContext.language === 'nl'
                ? 'Ik begrijp het niet helemaal. Vertel in je eigen woorden wat je zoekt—bijvoorbeeld je afspraken bekijken, een salon zoeken, of iets boeken?'
                : "I'm not sure what you need. Tell me in your own words—for example, are you looking to check your appointments, find a salon, or book one?";
            }
          }
        }

      // If user asked "Do I have a salon?" (ownership) but AI returned appointments — replace with ownership answer
      const askedDoIHaveASalon = /\b(do I have|heb ik)\s+(a |een )?(salon|slaon)\b/i.test(message) ||
        /\b(do I own|have I (got|registered))\s+a salon\b/i.test(message) ||
        /\bheb ik een salon\b/i.test(message);
      if (askedDoIHaveASalon && aiResponse && (/(you have|je hebt)\s+\d+\s*appointment|data-booking-id|booking\(s\)/i.test(aiResponse) || /Manicure|Hair Design|at \d{2}:\d{2}/i.test(aiResponse))) {
        try {
          const ownershipHtml = await this._doIHaveASalonFallback(message, userContext, userId, userToken);
          if (ownershipHtml) {
            aiResponse = ownershipHtml;
            console.log('🔄 Replaced appointments response with "Do I have a salon?" ownership answer');
          }
        } catch (e) {
          console.error('Error replacing appointments with ownership answer:', e);
        }
      }
      // POST-PROCESS: Replace forbidden responses
      const forbidden = /^\s*ik heb je verzoek verwerkt\.?\s*hoe kan ik je verder helpen\??\s*[.?!'"]*\s*$/i;
      if (aiResponse && forbidden.test(aiResponse.trim())) {
        const m = message.trim().toLowerCase();
        const isGreeting = /^(hallo|hi|hey|hoi|goedemorgen|goedemiddag|goedenavond|goedenacht|hello|good morning|good afternoon|good evening|yo|dag)\s*!?\.?$/i.test(m) || m.length <= 4;
        if (isGreeting) {
          aiResponse = userContext.language === 'nl'
            ? 'Hallo! Wat kan ik voor je doen?'
            : 'Hi! What can I do for you today?';
          console.log('🔄 Replaced forbidden "verwerkt" response with greeting (user said:', message.substring(0, 30), ')');
        } else {
          aiResponse = userContext.language === 'nl'
            ? 'Ik begrijp het niet helemaal. Kun je in je eigen woorden vertellen wat je nodig hebt?'
            : "I didn't quite get that. Could you tell me in your own words what you're looking for?";
          console.log('🔄 Replaced forbidden "verwerkt" response with follow-up (user said:', message.substring(0, 50), ')');
        }
      }
      // If the model said "one moment" / "I need to get that" / "Let me get that for you" for ANY booking-related query, complete the flow with actual data (never leave user with an incomplete reply).
      const saidFetching = aiResponse && /(one moment|get that from the API|I need to get that information|I need to fetch|I'll check|checking|let me get|I need to get|Let me get that for you)/i.test(aiResponse);
      const askedBookings = /\b(booking|appointment|do I have|when was the last|past|older|schedule|afspraak|boeking|planning|last time I did)\b/i.test(message);
      if (saidFetching && askedBookings) {
        try {
          const html = await this._bookingsFallback(message, userContext, userId, userToken);
          if (html) {
            aiResponse = html;
            console.log('🔄 Replaced "one moment" / "let me get" response with actual bookings (flow completed)');
          }
        } catch (e) {
          console.error('Error replacing "one moment" with bookings:', e);
        }
      }
      // If the model said it would fetch sales/earnings ("Let me check...", "your salon has earned", etc.) but didn't return data, do it now (same-turn fix).
      const saidFetchingSales = aiResponse && !/<output>|€\d|EUR|euro|revenue|verdiend|omzet/.test(aiResponse) &&
        /(Let me check if you made any sales|Let me check how much your salon|your salon has earned|salon has earned today|I'll need to retrieve your bookings and payment history|retrieve your bookings and payment history|calculate your earnings|calculate your revenue|check.*sales|fetch.*sales|hoeveel mijn salon|mijn salon heeft)/i.test(aiResponse);
      const messageIsAboutSales = /\b(sales|revenue|earnings|make today|earn|verdiend|omzet|winst)\b/i.test(message) ||
        /mijn salon|gekregen|hoeveel.*salon|salon.*vandag|salon.*(gekregen|earned|omzet)/i.test(message);
      if (saidFetchingSales && messageIsAboutSales) {
        try {
          const salesHtml = await this._salesAnalyticsFallback(message, userContext, userId, userToken);
          if (salesHtml) {
            aiResponse = salesHtml;
            console.log('🔄 Replaced "I\'ll fetch sales" response with actual sales data (same turn)');
          }
        } catch (e) {
          console.error('Error replacing "I\'ll fetch sales" with actual data:', e);
        }
      }
      // If the model said "Let me get that for you" or "I should be checking your past" with no actual data, replace with past bookings
      if (aiResponse && /(Let me get that for you|I should be checking your past)/i.test(aiResponse) && !/<output>|data-booking-id/.test(aiResponse)) {
        try {
          const html = await this._bookingsFallback('past bookings', userContext, userId, userToken);
          if (html) {
            aiResponse = html;
            console.log('🔄 Replaced "Let me get that" reply with actual past bookings');
          }
        } catch (e) {
          console.error('Error replacing "Let me get" with past bookings:', e);
        }
      }
      // If the model returned the generic "I'm not sure what you need" but user was doing a status-check after "one moment", replace with past bookings
      const isGenericFallback = aiResponse && /I'm not sure what you need|Tell me in your own words|Vertel in je eigen woorden/i.test(aiResponse);
      if (isGenericFallback && historyMessages && historyMessages.length >= 2) {
        const lastAssistant = [...historyMessages].reverse().find(m => m.role === 'assistant');
        const lastContent = (lastAssistant && lastAssistant.content) ? String(lastAssistant.content) : '';
        const msgTrim = message.trim().toLowerCase();
        const isStatusCheck = /\b(have u got anything|got anything|any luck|did you find|have you got|anything\?|got it\?|any update|have u forgot the context|did you forget|remember what I asked)\b/i.test(msgTrim);
        const lastSaidFetching = /(one moment|get that from the API|I need to get that information|checking|let me get|I'll check|fetching|I should be checking your past)/i.test(lastContent);
        if (isStatusCheck && lastSaidFetching) {
          try {
            const html = await this._bookingsFallback('past bookings', userContext, userId, userToken);
            if (html) {
              aiResponse = html;
              console.log('🔄 Replaced generic fallback with past bookings (user was status-check after "one moment")');
            }
          } catch (e) {
            console.error('Error replacing generic with past bookings:', e);
          }
        }
        // User said "Okay" / "Yes" / "Ja" etc. after assistant said they would fetch sales/earnings → run sales fallback with previous user message
        const isShortConfirmation = /^(okay|ok|yes|sure|go ahead|ja|prima|do it|yes please|doe maar|ga door|graag)\s*!?\.?$/i.test(msgTrim) || msgTrim === 'ok' || msgTrim === 'yes' || msgTrim === 'ja';
        const lastSaidFetchingSales = /(retrieve your bookings and payment history|calculate your earnings|Let me check if you made any sales|Let me check how much your salon|your salon has earned|I'll need to retrieve|payment history to calculate|check.*sales.*today|fetch.*(sales|revenue|earnings)|hoeveel mijn salon)/i.test(lastContent);
        if (isShortConfirmation && lastSaidFetchingSales) {
          const userMessages = historyMessages.filter(m => m.role === 'user');
          const previousUserContent = userMessages.length >= 2 ? (userMessages[userMessages.length - 2].content || '').trim() : message;
          try {
            const salesHtml = await this._salesAnalyticsFallback(previousUserContent, userContext, userId, userToken);
            if (salesHtml) {
              aiResponse = salesHtml;
              console.log('🔄 Replaced generic fallback with sales data (user said "Okay" after "I\'ll fetch sales")');
            }
          } catch (e) {
            console.error('Error replacing generic with sales after confirmation:', e);
          }
        }
      }
      // If the model said "I'm still working" or "I'm fetching" for sales, replace with actual data
      if (aiResponse && /(I'm still|still working|still fetching|I need to fetch|I'm fetching|It might take|I'll let you know|I need access|I don't have access).*(sales|revenue|analytics|data)/i.test(aiResponse) && /\b(sales|revenue|analytics|analyze|analyse|omzet|winst|verdiend)\b/i.test(message)) {
        try {
          const salesHtml = await this._salesAnalyticsFallback(message, userContext, userId, userToken);
          if (salesHtml) {
            aiResponse = salesHtml;
            console.log('🔄 Replaced "I\'m still working" response with actual sales data');
          }
        } catch (e) {
          console.error('Error in sales analytics fallback:', e);
        }
      }
      // If the model said "I can't analyze sales" or "I can only access" for sales, fetch and calculate
      if (aiResponse && /(I can't|cannot|can not|that functionality is not available|not available|I can only access|I don't have access|I need access to).*(analyze|sales|revenue|analytics)/i.test(aiResponse) && /\b(sales|revenue|analytics|analyze|analyse|omzet|winst|verdiend)\b/i.test(message)) {
        try {
          const salesHtml = await this._salesAnalyticsFallback(message, userContext, userId, userToken);
          if (salesHtml) {
            aiResponse = salesHtml;
            console.log('🔄 Replaced "cannot analyze sales" response with actual sales data');
          }
        } catch (e) {
          console.error('Error in sales analytics fallback:', e);
        }
      }
      // If salon owner asked "where is it" / "waar is het" but AI said "which salon?" / "provide the salon name" — get their salon from DB and return address
      if (userContext?.mySalonId && /\b(where is it|waar is het|where is my salon|waar is mijn salon)\b/i.test(message.trim()) &&
          aiResponse && /which salon|provide the salon name|salon name or ID|which salon are you/i.test(aiResponse)) {
        try {
          const mySalonHtml = await this._mySalonLocationFallback(message, userContext, userId, userToken);
          if (mySalonHtml) {
            aiResponse = mySalonHtml;
            console.log('🔄 Replaced "which salon?" with my-salon address (salon owner)');
          }
        } catch (e) {
          console.error('Error replacing which-salon with my-salon location:', e);
        }
      }
      // If user asked about sales/revenue but AI responded with just bookings (no revenue amount), replace with sales calculation
      if (aiResponse && /\b(sales|revenue|analytics|analyze|analyse|omzet|winst|verdiend|how much.*earn|how much.*make)\b/i.test(message) && 
          /(afspraak|appointment|booking|boeking)/i.test(aiResponse) && 
          !/(€|EUR|euro|omzet|revenue|sales|verdiend|earned|€\d)/i.test(aiResponse)) {
        try {
          const salesHtml = await this._salesAnalyticsFallback(message, userContext, userId, userToken);
          if (salesHtml) {
            aiResponse = salesHtml;
            console.log('🔄 Replaced bookings-only response with actual sales/revenue data');
          }
        } catch (e) {
          console.error('Error in sales analytics fallback:', e);
        }
      }
      // If user insists they have bookings/appointments ("I do but check it", "I do but", "check it its paid") after AI said no, fetch again
      if (aiResponse && /(no appointments|geen afspraken|no bookings)/i.test(aiResponse) && /\b(I do|I have|check it|its paid|check.*paid|successful.*payment)\b/i.test(message)) {
        try {
          const m = message.toLowerCase();
          const isToday = /\btoday\b|vandaag/i.test(m);
          const isPayment = /\b(paid|payment|successful|check.*paid)\b/i.test(m);
          
          if (isPayment) {
            // User wants to check payment status - fetch bookings and payments
            const paymentHtml = await this._paymentStatusFallback(historyMessages, message, userContext, userId, userToken, allFunctionResponses);
            if (paymentHtml) {
              aiResponse = paymentHtml;
              console.log('🔄 Replaced "no appointments" with payment status check after user insisted');
            }
          } else {
            // User insists they have bookings - fetch both upcoming and past
            const bookingsHtml = await this._bookingsFallback(message, userContext, userId, userToken);
            if (bookingsHtml && !/(no appointments|geen afspraken)/i.test(bookingsHtml)) {
              aiResponse = bookingsHtml;
              console.log('🔄 Replaced "no appointments" with bookings after user insisted');
            }
          }
        } catch (e) {
          console.error('Error checking bookings after user insisted:', e);
        }
      }
      // If the model said "I can't search for top-rated" or similar, fetch salons and show cards instead
      if (aiResponse && /I can't (directly )?search for (the )?top-rated|I can't find (the )?top-rated|I cannot (directly )?search for/i.test(aiResponse) && /\b(best|top|rated|recommend|popular)\b/i.test(message)) {
        try {
          const loc = userContext?.location;
          const q = loc ? { sort: 'rating', latitude: String(loc.latitude), longitude: String(loc.longitude) } : {};
          const ep = Object.keys(q).length >= 3 ? '/api/salons/search' : '/api/salons/popular';
          const res = await this.makeApiRequest(userId, userToken, 'GET', ep, null, q);
          let arr = Array.isArray(res?.data) ? res.data : res?.data?.data || res?.data?.salons || [];
          if (arr.length > 0) {
            const cards = arr.slice(0, 10).map(s => {
              const sid = s.id || '';
              const name = s.business_name || s.name || 'Salon';
              const r = s.rating_average != null ? ` ${Number(s.rating_average).toFixed(1)}` : '';
              return `<div class="ai-card" data-salon-id="${sid}" style="padding:12px;margin:8px 0;border:1px solid #e0e0e0;border-radius:8px;cursor:pointer;"><strong>${name}</strong>${r}</div>`;
            }).join('');
            aiResponse = `<output><p>${userContext?.language === 'nl' ? 'Top salons om te boeken:' : 'Top salons to book:'}</p>${cards}</output>`;
            console.log('🔄 Replaced "I can\'t search" deflection with salon cards');
          }
        } catch (e) { /* leave aiResponse as is */ }
      }

      // If the model replied with the generic "How can I help you?" / "Waar kan ik je mee helpen?" but the user
      // clearly asked for salons (best, recommend, book at best salon, etc.), fetch and show cards instead.
      // BUT: if they asked for ONE thing about ONE salon (picture, location, maps, services), show that—not the full list.
      const isGenericHelp = aiResponse && !/<output>/.test(aiResponse) && (
        (/How can I help you\?/i.test(aiResponse) && /bookings|salon|appointment/i.test(aiResponse)) ||
        (/Waar kan ik je mee helpen\?/i.test(aiResponse) && /boekingen|salon|afspraak/i.test(aiResponse))
      );
      const userWantsSalons = /\b(best|top|rated|recommend|popular|efficient|salon)\b/i.test(message) ||
        (/\bbook\b/i.test(message) && /\b(appointment|salon)\b/i.test(message));
      const userWantsBookings = (
        /\b(appointment|booking|bookings|plans|planning|agenda|schedule|afspraak|afspraken|boeking|boekingen)\b/i.test(message) ||
        /\b(do I have|heb ik|staat er|wat heb ik|heb ik.*iets|heb ik.*gepland|staat.*op.*planning|heb ik.*vandaag|heb ik.*morgen|heb ik.*gisteren)\b/i.test(message) ||
        /\b(any (plans|appointment)|(my|any) (bookings|appointments))\b/i.test(message) ||
        /\b(what about|how about) (yesterday|tomorrow|other days)\b/i.test(message) ||
        /\bother days\b/i.test(message)
      );
      const isOneSpecificThing = /\b(picture|image|photo|location|address|maps|map|navigate|services)\b|where is the picture|show me in maps|in a map|their services|what services|show me their services|what do they offer/i.test(message);
      const isBookingLocation = /\b(location|address|locatie|adres|waar is|where is|geef mij de locatie|give me the location)\b/i.test(message) && 
        (/\b(first|eerste|second|tweede|that|die|this|deze|booking|boeking)\b/i.test(message) || this._getBookingIdFromHistory(historyMessages));
      const isPaymentQuestion = /\b(payment|paid|successful|success|status|check if.*payment|was.*successful|yes or no)\b/i.test(message) && 
        (userWantsBookings || this._getBookingIdFromHistory(historyMessages));
      if (isGenericHelp && (userWantsSalons || isOneSpecificThing || userWantsBookings || isBookingLocation || isPaymentQuestion)) {
        if (isPaymentQuestion) {
          try {
            const html = await this._paymentStatusFallback(historyMessages, message, userContext, userId, userToken, allFunctionResponses);
            if (html) { aiResponse = html; console.log('🔄 Replaced generic with payment status'); }
          } catch (e) { /* leave generic */ }
        } else if (isBookingLocation) {
          try {
            const html = await this._bookingLocationFallback(historyMessages, message, userContext, userId, userToken, allFunctionResponses);
            if (html) { aiResponse = html; console.log('🔄 Replaced generic with booking location'); }
          } catch (e) { /* leave generic */ }
        } else if (isOneSpecificThing) {
          try {
            const html = await this._oneSalonDetailFallback(historyMessages, message, userContext, userId, userToken);
            if (html) { aiResponse = html; console.log('🔄 Replaced generic with one-salon detail (picture/maps/services)'); }
          } catch (e) { /* leave generic */ }
        } else if (userWantsBookings) {
          try {
            const html = await this._bookingsFallback(message, userContext, userId, userToken);
            if (html) { aiResponse = html; console.log('🔄 Replaced generic with bookings'); }
          } catch (e) { /* leave generic */ }
        } else {
          try {
            const loc = userContext?.location;
            const q = loc ? { sort: 'rating', latitude: String(loc.latitude), longitude: String(loc.longitude) } : {};
            const ep = Object.keys(q).length >= 3 ? '/api/salons/search' : '/api/salons/popular';
            const res = await this.makeApiRequest(userId, userToken, 'GET', ep, null, q);
            let arr = Array.isArray(res?.data) ? res.data : res?.data?.data || res?.data?.salons || [];
            if (arr.length > 0) {
              const cards = arr.slice(0, 10).map(s => {
                const sid = s.id || ''; const name = s.business_name || s.name || 'Salon';
                const r = s.rating_average != null ? ` ${Number(s.rating_average).toFixed(1)}` : '';
                return `<div class="ai-card" data-salon-id="${sid}" style="padding:12px;margin:8px 0;border:1px solid #e0e0e0;border-radius:8px;cursor:pointer;"><strong>${name}</strong>${r}</div>`;
              }).join('');
              const head = userContext?.language === 'nl' ? 'Top salons om te boeken:' : 'Top salons to book:';
              aiResponse = `<output><p>${head}</p>${cards}</output>`;
              console.log('🔄 Replaced generic "How can I help" with salon cards (user asked for salons)');
            }
          } catch (e) { /* leave aiResponse as is */ }
        }
      }

      // If the user gave a positive affirmation ("Perfect", "I love this one", etc.) about a salon we just discussed
      // but the AI replied with the generic, replace with an acknowledgment and offer to book.
      const userIsPositiveAffirmation = /\b(perfect|great|love|like|mooi|prima|geweldig|lekker|super|nice|sounds good|i'll take it|this one|that one|i want that one|yes that one|love it)\b/i.test(message);
      const recentContextIsSalon = !!this._getSalonIdFromHistory(historyMessages);
      if (isGenericHelp && userIsPositiveAffirmation && recentContextIsSalon) {
        aiResponse = userContext?.language === 'nl'
          ? 'Fijn dat je ervan houdt! Zal ik je helpen een afspraak te maken?'
          : 'Glad you like it! Would you like to book an appointment there?';
        console.log('🔄 Replaced generic after positive affirmation with acknowledgment + offer to book');
      }

      // If the user asked for ONE thing (picture, location, maps, services) but the AI returned the FULL salon list,
      // text without an image, or generic without a service list, replace with the one-salon detail.
      const looksLikeFullList = (aiResponse && ((aiResponse.match(/data-salon-id/g) || []).length > 1) || /Top salons to book|Gevonden resultaten|to book:/i.test(aiResponse));
      const askedPictureButNoImg = /\b(picture|image|photo)\b|where is the picture/i.test(message) && aiResponse && !/<img|class="ai-image"/.test(aiResponse);
      const askedForServicesButNoServiceContent = /\bservices\b|their services|what services|show me their services|what do they offer/i.test(message) && aiResponse && !/service|€|EUR|duration|min|ai-card|data-service/i.test(aiResponse);
      if (isOneSpecificThing && (looksLikeFullList || askedPictureButNoImg || askedForServicesButNoServiceContent)) {
        try {
          const html = await this._oneSalonDetailFallback(historyMessages, message, userContext, userId, userToken);
          if (html) { aiResponse = html; console.log('🔄 Replaced full list / text with one-salon detail (picture/maps/services)'); }
        } catch (e) { /* leave as is */ }
      }

      // If the user asked about appointments/bookings but the AI didn't return booking cards or a clear "no" message, fetch and show
      const askedForBookingsButNoBookingContent = userWantsBookings && aiResponse && !/data-booking-id|no (appointment|booking)|geen (afspraak|boeking)/i.test(aiResponse);
      if (askedForBookingsButNoBookingContent) {
        try {
          const html = await this._bookingsFallback(message, userContext, userId, userToken);
          if (html) { aiResponse = html; console.log('🔄 Replaced non-booking response with bookings'); }
        } catch (e) { /* leave as is */ }
      }

      // Check if response contains GenUI/A2UI commands (legacy support - not actively used)
      // The AI might include GenUI commands in its response, but we primarily use HTML now
      let genuiMetadata = null;
      try {
        // Try to parse GenUI commands from response text (JSON code blocks)
        const genuiMatch = aiResponse.match(/```json\s*({[\s\S]*?})\s*```/);
        if (genuiMatch) {
          const genuiJson = JSON.parse(genuiMatch[1]);
          if (genuiJson.command || genuiJson.surfaceId || genuiJson.genui) {
            genuiMetadata = { genui: genuiJson.genui || genuiJson };
            // Remove GenUI JSON from text response
            aiResponse = aiResponse.replace(/```json\s*{[\s\S]*?}\s*```/g, '').trim();
          }
        }
        
        // Also check if GenUI is in the response text as a JSON object (without code blocks)
        if (!genuiMetadata) {
          const directJsonMatch = aiResponse.match(/\{[\s\S]*"genui"[\s\S]*\}/);
          if (directJsonMatch) {
            try {
              const parsed = JSON.parse(directJsonMatch[0]);
              if (parsed.genui) {
                genuiMetadata = { genui: parsed.genui };
                // Remove from text
                aiResponse = aiResponse.replace(directJsonMatch[0], '').trim();
              }
            } catch (e) {
              // Not valid JSON, continue
            }
          }
        }
        
        // Also check for "genui" key at root level
        if (!genuiMetadata) {
          const rootGenuiMatch = aiResponse.match(/\{[\s\S]*"command"[\s\S]*"surfaceId"[\s\S]*\}/);
          if (rootGenuiMatch) {
            try {
              const parsed = JSON.parse(rootGenuiMatch[0]);
              if (parsed.command || parsed.surfaceId) {
                genuiMetadata = { genui: parsed };
                aiResponse = aiResponse.replace(rootGenuiMatch[0], '').trim();
              }
            } catch (e) {
              // Not valid JSON, continue
            }
          }
        }
      } catch (e) {
        // If parsing fails, continue without GenUI (legacy support)
      }

      // If AI said "let me check" or "even kijken" but didn't actually fetch data, force the fallback
      const saidCheckingButNoData = aiResponse && (
        /(even kijken|een momentje|let me check|ik ga kijken|i'll check)/i.test(aiResponse) &&
        !/<output>/.test(aiResponse) &&
        !/data-booking-id|data-salon-id/i.test(aiResponse)
      );
      if (saidCheckingButNoData && userWantsBookings) {
        try {
          const html = await this._bookingsFallback(message, userContext, userId, userToken);
          if (html) {
            aiResponse = html;
            console.log('🔄 AI said "checking" but no data - forced bookings fallback');
          }
        } catch (e) {
          console.error('Error forcing bookings after "checking" message:', e);
        }
      }

      // Ensure we never save or send an empty response (e.g. after genui strip removed everything)
      if (!aiResponse || !String(aiResponse).trim()) {
        // If they asked about bookings but got empty response, try fallback one more time
        if (userWantsBookings) {
          try {
            const html = await this._bookingsFallback(message, userContext, userId, userToken);
            if (html) {
              aiResponse = html;
              console.log('🔄 Empty response but booking query - forced fallback');
            }
          } catch (e) {}
        }
        if (!aiResponse || !String(aiResponse).trim()) {
          aiResponse = userContext?.language === 'nl'
            ? 'Ik begrijp het niet helemaal. Vertel in je eigen woorden wat je zoekt—bijvoorbeeld je afspraken bekijken, een salon zoeken, of iets boeken?'
            : "I'm not sure what you need. Tell me in your own words—for example, are you looking to check your appointments, find a salon, or book one?";
        }
      }

      // Never surface the robotic menu-like phrase; if it slipped through, replace with human language
      const roboticPhrase = /How can I help you\?.*(bookings|salon|appointment)|Waar kan ik je mee helpen\?.*(boekingen|salon|afspraak)/i;
      if (aiResponse && roboticPhrase.test(aiResponse)) {
        aiResponse = userContext?.language === 'nl'
          ? 'Ik begrijp het niet helemaal. Vertel in je eigen woorden wat je zoekt—bijvoorbeeld je afspraken bekijken, een salon zoeken, of iets boeken?'
          : "I'm not sure what you need. Tell me in your own words—for example, are you looking to check your appointments, find a salon, or book one?";
        console.log('🔄 Replaced robotic phrase with human fallback');
      }

      // Last-chance: if they asked about bookings (today, yesterday, "how about yesterday", etc.) and we still
      // don't have booking content or a clear "no", run _bookingsFallback (catches any missed path)
      if (userWantsBookings && aiResponse && !/data-booking-id|no (appointment|booking)|geen (afspraak|boeking)/i.test(aiResponse)) {
        try {
          const html = await this._bookingsFallback(message, userContext, userId, userToken);
          if (html) { aiResponse = html; console.log('🔄 Last-chance: replaced with bookings'); }
        } catch (e) { /* leave as is */ }
      }

      // Store last booking data in metadata for follow-up questions
      let lastBookingData = null;
      if (allFunctionResponses && allFunctionResponses.length > 0) {
        for (let i = allFunctionResponses.length - 1; i >= 0; i--) {
          const funcResp = allFunctionResponses[i];
          const responseData = funcResp?.functionResponse?.response?.data;
          if (responseData) {
            let bookings = [];
            if (Array.isArray(responseData)) {
              bookings = responseData;
            } else if (responseData.data?.bookings && Array.isArray(responseData.data.bookings)) {
              bookings = responseData.data.bookings;
            } else if (responseData.bookings && Array.isArray(responseData.bookings)) {
              bookings = responseData.bookings;
            }
            if (bookings.length > 0) {
              lastBookingData = bookings;
              break;
            }
          }
        }
      }

      // Save AI response
      const { data: aiMessage, error: aiMsgError } = await authenticatedClient
        .from('ai_messages')
        .insert({
          conversation_id: currentConversationId,
          role: 'assistant',
          content: aiResponse,
          metadata: {
            model: config.ai.gemini_model,
            tokens_used: response.usageMetadata?.totalTokenCount || null,
            lastBookingData: lastBookingData, // Store for follow-up questions
            ...(genuiMetadata || {})
          }
        })
        .select()
        .single();

      // Save AI message (errors are non-critical)

      // Update conversation updated_at
      await authenticatedClient
        .from('ai_conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', currentConversationId);

      const safeContent = (userContext?.language === 'nl' ? 'Er ging iets mis. Probeer het opnieuw.' : 'Something went wrong. Please try again.');
      const finalContent = String((aiMessage && aiMessage.content) || aiResponse || '').trim() || safeContent;
      res.json({
        success: true,
        conversationId: currentConversationId,
        userMessage: userMessage,
        aiMessage: {
          id: (aiMessage && aiMessage.id) || null,
          role: 'assistant',
          content: finalContent,
          created_at: (aiMessage && aiMessage.created_at) || new Date().toISOString()
        }
      });
    } catch (error) {
      // Check if model is initialized
      if (!this.model) {
        throw new AppError(
          'AI service is not available. Please check server configuration.',
          503,
          'AI_SERVICE_UNAVAILABLE'
        );
      }
      
      // Save error message
      try {
        const authenticatedClient = getAuthenticatedClient(req.token);
        await authenticatedClient
          .from('ai_messages')
          .insert({
            conversation_id: currentConversationId,
            role: 'assistant',
            content: `I apologize, but I encountered an error: ${error.message || 'Unknown error'}. Please try again.`,
            metadata: { 
              error: error.message,
              errorName: error.name,
              errorCode: error.code
            }
          })
          .select()
          .single();
      } catch (saveError) {
        // Silently fail error message saving
      }

      // Return more detailed error to help debugging
      const errorMessage = error.message || 'Unknown error';
      const errorDetails = {
        originalError: errorMessage,
        errorName: error.name,
        errorCode: error.code,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      };
      
      throw new AppError(
        `Failed to get AI response: ${errorMessage}`,
        500,
        'AI_RESPONSE_ERROR',
        errorDetails
      );
    }
  });

  // Delete conversation
  deleteConversation = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const authenticatedClient = getAuthenticatedClient(req.token);

    // Verify conversation belongs to user
    const { data: conversation, error: convError } = await authenticatedClient
      .from('ai_conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .single();

    if (convError || !conversation) {
      throw new AppError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
    }

    // Delete conversation (cascade will delete messages)
    const { error } = await authenticatedClient
      .from('ai_conversations')
      .delete()
      .eq('id', conversationId);

    if (error) {
      throw new AppError('Failed to delete conversation', 500, 'DELETE_CONVERSATION_ERROR');
    }

    res.json({
      success: true,
      message: 'Conversation deleted successfully'
    });
  });

  // Update conversation title
  updateConversationTitle = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const { title } = req.body;
    const authenticatedClient = getAuthenticatedClient(req.token);

    if (!title || title.trim().length === 0) {
      throw new AppError('Title is required', 400, 'TITLE_REQUIRED');
    }

    // Verify conversation belongs to user
    const { data: conversation, error: convError } = await authenticatedClient
      .from('ai_conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .single();

    if (convError || !conversation) {
      throw new AppError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
    }

    const { data: updated, error } = await authenticatedClient
      .from('ai_conversations')
      .update({ title: title.trim() })
      .eq('id', conversationId)
      .select()
      .single();

    if (error) {
      throw new AppError('Failed to update conversation title', 500, 'UPDATE_TITLE_ERROR');
    }

    res.json({
      success: true,
      conversation: updated
    });
  });
}

module.exports = new AIController();
