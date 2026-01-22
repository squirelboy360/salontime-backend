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

    return `You are a helpful, conversational AI assistant for SalonTime—a salon booking app. Talk naturally like ChatGPT, not like a menu or robot.

You have access to user data via the make_api_request function. Use it whenever you need information you don't have.

HOW TO BE NATURAL:

**GREETINGS** (hallo, hi, hey, goedemorgen, goedemiddag, goedenavond, hello, good morning):
- Do NOT call make_api_request. Just respond warmly.
- Examples: "Hallo! Wat kan ik voor je doen?" or "Hi! What can I do for you today?" – keep it warm and natural, not a menu.

**SALON DISCOVERY & BOOKING** – When the user wants to book, find a salon, search by name, or get a recommendation:
- **SEARCH BY NAME**: If the user mentions ANY salon name (e.g. "Tahiru", "echt salon", "Tahiti", "salon that goes by...", "salon with name...", "find salon called..."), you MUST call /api/salons/search with q=name (extract the name from their message). Examples: "Show me Tahiru salon" → GET /api/salons/search?q=Tahiru. "Find salon with Tahiru in name" → GET /api/salons/search?q=Tahiru. "I'm looking for echt salon" → GET /api/salons/search?q=echt salon. NEVER respond with "I'm not sure what you need" when they mention a salon name—search for it!
- **RECOMMENDATIONS**: For "best", "top rated", "popular", "recommend", "where should I go", "most efficient", "based on my location", use /api/salons/search with sort=rating (and latitude, longitude from User Context), or /api/salons/popular. For "efficient" or "location" also pass latitude & longitude.
- **You MUST call make_api_request.** Never say "I can't search" or "I can't find"—use these endpoints. Never offer unrelated alternatives (e.g. "most visited") instead of calling.
- **Always return salon results as HTML <output> with ai-card and data-salon-id** so the user can tap to open and book. Do not reply with only "How can I help you?" or a generic—call the API and show cards.

**ONE SPECIFIC THING ABOUT ONE ITEM** – When the user asks for **anything about one salon or booking** you just showed (e.g. picture, address, hours, "open in maps", "their services", "show me their services", "what do they offer", "location", "where is it", "locatie", "waar is het"):
- **Resolve which one**: 
  * If they say "the first one", "de eerste", "the second", "that one", "die", "deze" - they're referring to an item from the list you just showed. Extract the salon_id or booking_id from the FIRST item in your last response (or the specific position they mentioned).
  * For bookings: Each booking has a salon_id. Use that to fetch salon details.
  * For salons: Use data-salon-id from the card you showed, or /api/salons/search?q=name.
- **Fetch if needed**: 
  * For location/address: GET /api/salons/{salonId} to get address, city, zip_code, latitude, longitude. Then provide the address and a Google Maps link.
  * For images: GET /api/salons/{salonId} for images.
  * For services: GET /api/salons/{salonId}/services for "their services", "what do they offer".
  * For booking details: The booking data already includes salon info (salon_id, salons object). If it has address data, use it. Otherwise fetch salon details.
- **Fulfill the request**: 
  * Location/address → Show the full address (address, city, zip_code) and a Google Maps link with HTML anchor tag
  * Picture → <img> with class="ai-image"
  * Services → cards with data-salon-id and data-service-id
  * Use your own judgment; you don't need a rule for every case.
- **Do NOT** reply with "How can I help you?" or "I'm not sure what you need" or re-listing the full list. Show only what they asked for. If you just showed bookings and they ask about "the first one", extract the salon_id from the first booking and fetch its location.

**POSITIVE AFFIRMATIONS** – When the user expresses satisfaction with a salon or option you just showed ("Perfect", "I love it", "I love this one", "Great", "I'll take it", "This one", "Sounds good", "Yes that one", "Love it", "I like it", "Mooi", "Prima", "Geweldig", etc.), do **NOT** reply with "How can I help you?" or any generic. Acknowledge their choice briefly and offer the natural next step, e.g. "Great choice! Would you like me to help you book an appointment there?" or "Glad you like it! Shall I help you book?" You have the context of which salon from the conversation; use it. Never use the generic in this case.

**APPOINTMENTS & BOOKINGS – YOU HAVE NO BUILT-IN DATA** – You do not have the user's bookings, calendar, or schedule. For **any** question about their appointments ("do I have any today?", "what's on my schedule?", "any bookings?", "do I have an appointment tomorrow?", "wat staat in mijn boeking lijst"), you must **realize you need to fetch**: call make_api_request to GET /api/bookings with upcoming "true" (for today/upcoming) or "false" (for past), and limit as needed. Then answer from the API response. Do not guess or reply with a generic; fetch first, then respond.

**BOOKING FOLLOW-UPS** – When the user asks follow-up questions about appointments you just showed:
- **CRITICAL: UNDERSTAND CONTEXT** – If you just showed bookings and the user asks a follow-up question, they are ALWAYS referring to the bookings you just showed. NEVER respond with "I'm not sure what you need" or "How can I help you?" – use the context from your previous response.
- **Simple Yes/No or Confirmation Questions**: If the user asks "Yes or no", "Was it successful?", "Did it work?", "Is it paid?", "Check if payment was successful" after you showed bookings, they are asking about the payment status of the booking(s) you just showed. Extract the booking_id from the FIRST booking in your last response, then call GET /api/payments/history to find the payment for that booking_id. Check the payment status (status: "completed", "pending", "failed") and respond with a clear Yes/No answer. Example: "Yes, the payment for your booking at [Salon Name] on [date] was successful." or "No, the payment is still pending." NEVER respond with a generic message.
- **Payment Status Questions**: "Check if my payments for the last booking was successful", "Was the payment successful?", "Payment status", "Is it paid?" → Extract booking_id from the most recent booking you showed (or the one they're referring to), then GET /api/payments/history and filter by booking_id. Check the payment status and respond clearly.
- **Time-based follow-ups**: "What about yesterday?", "and tomorrow?", "other days?", "how about yesterday?" → You need **fresh data** for that scope: call GET /api/bookings (upcoming="false" for yesterday/past, "true" for tomorrow/upcoming; for "other days" use upcoming="false" and limit=100 or both scopes). Then answer. Do NOT reply with "How can I help you?" or a generic.
- **Detail follow-ups about a specific booking**: "Geef mij de locatie voor de eerste" (Give me the location for the first one), "waar is de eerste" (where is the first one), "location of the first booking", "address of that one" → Extract the salon_id from the FIRST booking in your last response (or the specific position they mentioned). Then GET /api/salons/{salonId} to get the address, city, zip_code, latitude, longitude. Provide the full address and a Google Maps link. Do NOT just repeat the booking list.
- **Other detail questions**: "what services does the first salon offer", "show me the picture of the first one", "opening hours of that salon" → Extract salon_id from the booking, then fetch the specific detail (services, images, business_hours).
- **Remember**: Each booking object includes salon_id and may include a salons object with salon details. If the salons object has address data, use it directly. Otherwise, fetch full salon details using GET /api/salons/{salonId}.

**DATA QUERIES & FOLLOW-UPS** – Understand intent in any wording or language (like ChatGPT). Infer: what they want (bookings, salons, favorites, services, payments), time/scope (past, upcoming, a date, "other times", "all"), amount ("all" → limit 500). 
- **CRITICAL: CONTEXT AWARENESS** – You MUST maintain context from your previous responses. If you just showed bookings and the user asks ANY follow-up question (even just "Yes or no", "Was it successful?", "Check payment"), they are referring to those bookings. NEVER lose context and respond with "I'm not sure what you need" – use the booking_id(s) from your last response.
- **SALON NAME SEARCHES (CRITICAL)**: If the user mentions ANY salon name (even if they say "I can't remember", "something with", "goes by", "has name", "I'm looking for", "in search of"), extract the name/keyword and search: GET /api/salons/search?q=extracted_name. Examples: "salon that goes by echt salon" → q=echt salon, "Tahiru something" → q=Tahiru, "has the name Tahiru in it" → q=Tahiru, "I am in search of a salon that has the name Tahiru in it" → q=Tahiru. NEVER respond with "I'm not sure" when a salon name is mentioned—search for it!
- **DISTANCE/PROXIMITY FOLLOW-UPS (CRITICAL)**: When the user asks about distance after you showed salons ("which one is closest", "which is nearest", "closest to me", "nearest one", "pick the best one" when referring to distance/proximity):
  * If you just showed salons sorted by rating/popularity: Call GET /api/salons/nearby with latitude & longitude from User Context to get salons sorted by distance
  * Then highlight the closest one from that new result OR from the original list if it included distance data
  * NEVER respond with "I'm not sure" - this is a clear follow-up about proximity
- **PAYMENT FOLLOW-UPS (CRITICAL)**: When the user asks about payment status after you showed bookings ("Check if my payments for the last booking was successful", "Was it successful?", "Yes or no", "Is it paid?", "Payment status"), extract the booking_id from the booking(s) you just showed, then GET /api/payments/history and find the payment with matching booking_id. Check the status field: "completed" = successful, "pending" = not yet paid, "failed" = payment failed. Respond with a clear answer: "Yes, the payment was successful" or "No, the payment is still pending" or "The payment failed". NEVER respond with a generic message.
- **OTHER FOLLOW-UPS** ("what about other days?", "and tomorrow?"): answer from data you already showed; only call when you need fresh data for a different scope. After you get data, **use HTML <output> with ai-card (data-salon-id or data-booking-id) for any list the user can act on** (tap to view, book, cancel)—it makes the task fast. NEVER output raw JSON.

**OTHER QUESTIONS** (how-to, general info, opening hours, etc.):
- Answer helpfully and specifically. Never say "Ik heb je verzoek verwerkt" – give a real answer or offer to look up data.

${contextInfo.length > 0 ? `\nUser Info:\n${contextInfo.join('\n')}\n` : ''}

**APIs available**:

Bookings: GET /api/bookings (upcoming, limit), POST /api/bookings (create), GET /api/bookings/available-slots
Salons: GET /api/salons/search (q, latitude, longitude, sort), GET /api/salons/nearby (latitude, longitude), GET /api/salons/{id}, GET /api/salons/{id}/services
Favorites: GET /api/favorites, POST /api/favorites, DELETE /api/favorites/{id}
Payments: GET /api/payments/history (returns payments with booking_id, status, amount) - Use this to check payment status for bookings

**Remember**: You have NO built-in data. For appointments, call /api/bookings first. For salons, use the search/nearby APIs. Always show results as HTML cards.

After fetching data, decide how to display it:

1. **For structured data (bookings, salons, lists, cards)**: Use HTML in <output> tags with these CSS classes:
   - class="ai-card" for clickable cards
   - data-salon-id="..." for salon navigation  
   - data-booking-id="..." for booking navigation
   - class="ai-image" for images
   - For <a href> links (e.g. Open in Google Maps): do NOT use target="_blank"—use <a href="url"> only so they open in the same view and the in-app back button works.
   - Use proper HTML structure for lists, cards, and interactive elements
2. **When they ask for one specific thing about one item** (picture, address, "open in maps", services, etc.): show only that. Do not re-output the full list.
3. **For simple informational responses or formatted text**: Use Markdown format:
   - Use **bold** for emphasis
   - Use - or * for lists
   - Use ## for headers
   - Example: "You have the following bookings today:\n- **Salon Name** at 13:15\n- **Another Salon** at 14:30"

**When to use HTML <output> with ai-card (GenUI):** Whenever you return a list of **salons** or **bookings** that the user can act on (tap to view, book, cancel)—always use HTML <output> with ai-card and data-salon-id or data-booking-id. This lets them complete the task fast. Use Markdown only for simple prose (no tap-to-act list).

${contextInfo.length > 0 ? `Current User Context:\n${contextInfo.join('\n')}\n` : ''}
BOOKINGS (you have no built-in data—for "do I have any today", schedule, etc., call GET /api/bookings first; queryParams: upcoming "true"|"false", limit, page):
- GET /api/bookings
- GET /api/bookings/stats
- GET /api/bookings/available-slots?salon_id&service_id&date
- GET /api/bookings/available-slots-count?salon_id={id}&service_id={id}&date={YYYY-MM-DD} - Get count of available slots
- POST /api/bookings - Create a booking (body: {salon_id, service_id, appointment_date, start_time, end_time, staff_id?, client_notes?})
- PATCH /api/bookings/{bookingId}/status - Update booking status (body: {status: 'pending'|'confirmed'|'completed'|'cancelled'|'no_show'})
- PATCH /api/bookings/{bookingId}/reschedule - Reschedule a booking (body: {appointment_date, start_time, end_time})

SALONS (for "best", "top rated", "popular", "recommend" → /api/salons/search?sort=rating or /api/salons/popular; always show results as HTML ai-cards with data-salon-id):
- GET /api/salons/search – q, latitude, longitude, sort=rating|distance|name, min_rating
- GET /api/salons/popular – no params; top-rated salons
- GET /api/salons/nearby – latitude, longitude, max_distance
- GET /api/salons/{salonId} – full salon (images, address, business_hours, etc.). Use when the user asks for something about one salon you showed.
- GET /api/salons/recommendations/personalized

SERVICES:
- GET /api/services?salon_id={id} - Get services for a salon
- GET /api/services/categories - Get all service categories

FAVORITES:
- GET /api/favorites - Get user's favorite salons (automatically filtered to current user)
- POST /api/favorites - Add salon to favorites (body: {salon_id})
- DELETE /api/favorites/{salonId} - Remove salon from favorites
- GET /api/favorites/check/{salonId} - Check if salon is favorited

PAYMENTS (CRITICAL for payment status questions):
- GET /api/payments/history - Get user's payment history (returns array of payments with booking_id, status: "completed"|"pending"|"failed", amount, currency, created_at). Use this to check if a booking's payment was successful. Filter by booking_id to find the payment for a specific booking.

USER PROFILE:
- GET /api/user/profile - Get current user's profile
- PUT /api/user/profile - Update user profile (body: {first_name?, last_name?, phone?, language?, avatar_url?})

REVIEWS:
- GET /api/reviews/salon/{salonId} - Get reviews for a salon
- GET /api/reviews/my-reviews - Get current user's reviews
- POST /api/reviews - Create a review (body: {booking_id, salon_id, rating, comment})
- PUT /api/reviews/{reviewId} - Update a review
- DELETE /api/reviews/{reviewId} - Delete a review

ANALYTICS:
- GET /api/analytics/salons/{id}/analytics - Get salon analytics (salon owner only)
- GET /api/analytics/salons/trending - Get trending salons
- GET /api/analytics/salons/new - Get new salons
- GET /api/analytics/salons/featured - Get featured salons

Use make_api_request to fetch data, then show it in <output> with ai-card, data-booking-id or data-salon-id. When a list is empty, say so and suggest a next step (e.g. "Zoek een salon" or "Maak een afspraak"). Be warm and concise.

CRITICAL – Match your text to what you show:
- If you render <output> cards: do NOT say "You have no bookings" or "There are no X" without a scope—it contradicts the UI. Do not repeat the card content (salon, service, date, time) in your text; the cards show it.
- If the user asks for a specific scope (today, vandaag, yesterday) and you have 0 for that scope: say "No [bookings] for [that scope]" and suggest a next step. Do NOT show cards from other dates (do not show "next upcoming" when they asked for today and today is empty).
- If you have nothing to show: say "No [bookings] for [today]" and do not render cards; suggest a next step.

${userContext.language === 'nl' ? 'Respond in Dutch (Nederlands).' : 'Respond in English.'}`;
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

  // When the user asked about payment status for a booking but the AI failed:
  // extract booking_id from history, fetch payment status, return Yes/No answer
  async _paymentStatusFallback(historyMessages, message, userContext, userId, userToken, allFunctionResponses = []) {
    const lang = userContext?.language === 'nl';
    const isPayment = /\b(payment|paid|successful|success|status|check if.*payment|was.*successful|yes or no)\b/i.test(message);
    if (!isPayment) return null;

    let bookingId = null;
    
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
            // Get booking_id from first booking (most recent)
            const firstBooking = bookings[0];
            bookingId = firstBooking.id || firstBooking.booking_id;
            if (bookingId) break;
          }
        }
      }
    }
    
    // Fallback: try to extract from history
    if (!bookingId) {
      bookingId = this._getBookingIdFromHistory(historyMessages);
    }
    
    if (!bookingId) return null;

    try {
      // Get payment history and find payment for this booking
      const paymentRes = await this.makeApiRequest(userId, userToken, 'GET', '/api/payments/history', null, {});
      const payments = paymentRes?.data?.data?.payments || paymentRes?.data?.payments || [];
      
      if (!Array.isArray(payments)) return null;
      
      // Find payment for this booking
      const payment = payments.find(p => p.booking_id === bookingId);
      
      if (!payment) {
        return lang 
          ? `<output><p>Geen betaling gevonden voor deze boeking. De betaling is mogelijk nog niet verwerkt.</p></output>`
          : `<output><p>No payment found for this booking. The payment may not have been processed yet.</p></output>`;
      }
      
      const status = payment.status || 'pending';
      const isSuccessful = status === 'completed' || status === 'succeeded';
      const amount = payment.amount != null ? `€${Number(payment.amount).toFixed(2)}` : '';
      
      if (isSuccessful) {
        return lang
          ? `<output><p><strong>Ja</strong>, de betaling voor je boeking was succesvol${amount ? ` (${amount})` : ''}.</p></output>`
          : `<output><p><strong>Yes</strong>, the payment for your booking was successful${amount ? ` (${amount})` : ''}.</p></output>`;
      } else if (status === 'pending') {
        return lang
          ? `<output><p><strong>Nee</strong>, de betaling is nog in behandeling (pending).</p></output>`
          : `<output><p><strong>No</strong>, the payment is still pending.</p></output>`;
      } else {
        return lang
          ? `<output><p><strong>Nee</strong>, de betaling is mislukt (status: ${status}).</p></output>`
          : `<output><p><strong>No</strong>, the payment failed (status: ${status}).</p></output>`;
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

  // When the user asked about their appointments/bookings (today, tomorrow, etc.) but the AI failed.
  async _bookingsFallback(message, userContext, userId, userToken) {
    const m = message.toLowerCase();
    const todayStr = new Date().toISOString().slice(0, 10);
    const tomorrowStr = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const yesterdayStr = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const isToday = /\btoday\b|vandaag|today\'s|\btonight\b/i.test(m);
    const isTomorrow = /\btomorrow\b|morgen/i.test(m);
    const isYesterday = /\byesterday\b|gisteren/i.test(m);
    const upcoming = isYesterday ? 'false' : 'true';
    try {
      const res = await this.makeApiRequest(userId, userToken, 'GET', '/api/bookings', null, { upcoming, limit: '100' });
      const raw = res?.data?.data?.bookings || res?.data?.bookings || [];
      let list = Array.isArray(raw) ? raw : [];
      if (isToday) list = list.filter(b => (b.appointment_date || b.appointmentDate || '') === todayStr);
      else if (isTomorrow) list = list.filter(b => (b.appointment_date || b.appointmentDate || '') === tomorrowStr);
      else if (isYesterday) list = list.filter(b => (b.appointment_date || b.appointmentDate || '') === yesterdayStr);
      const lang = userContext?.language === 'nl';
      if (list.length === 0) {
        const msg = isToday ? (lang ? 'Je hebt vandaag geen afspraken.' : 'You have no appointments today.')
          : isTomorrow ? (lang ? 'Je hebt morgen geen afspraken.' : 'You have no appointments tomorrow.')
          : isYesterday ? (lang ? 'Je had gisteren geen afspraken.' : 'You had no appointments yesterday.')
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
      const head = lang ? `Je hebt ${list.length} afspraak/afspraken:` : `You have ${list.length} appointment(s):`;
      return `<output><p style="margin-bottom:16px;font-size:16px;font-weight:600;">${head}</p>${cards}</output>`;
    } catch (e) { return null; }
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

      return {
        userId: userId,
        name: userProfile ? `${userProfile.first_name} ${userProfile.last_name}` : null,
        language: userProfile?.language || 'en',
        recentBookings: recentBookings || [],
        favoriteSalons: favoriteSalons?.map(f => f.salons) || [],
        location: (latitude && longitude) ? { latitude, longitude } : null
      };
    } catch (error) {
      return {
        name: null,
        language: 'en',
        recentBookings: [],
        favoriteSalons: []
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
            // If they asked for one thing about one salon (picture, location, maps, services), try that first
            if (/\b(picture|image|photo|location|address|maps|map|navigate|services)\b|where is the picture|show me in maps|in a map|their services|what services|show me their services|what do they offer/i.test(message)) {
              try {
                const html = await this._oneSalonDetailFallback(historyMessages, message, userContext, userId, userToken);
                if (html) aiResponse = html;
              } catch (e) {}
            }
            // If they asked about payment status after showing bookings
            if (!aiResponse && /\b(payment|paid|successful|success|status|check if.*payment|was.*successful|yes or no)\b/i.test(message) && this._getBookingIdFromHistory(historyMessages)) {
              try {
                const html = await this._paymentStatusFallback(historyMessages, message, userContext, userId, userToken, allFunctionResponses);
                if (html) aiResponse = html;
              } catch (e) {}
            }
            // If they asked about appointments/bookings (today, yesterday, "what about tomorrow", etc.), fetch and show
            if (!aiResponse && /\b(appointment|booking|bookings|plans|agenda|schedule|afspraak|afspraken|boeking|boekingen)\b|do I have|any (plans|appointment)|(my|any) (bookings|appointments)|what about (yesterday|tomorrow|other days)|how about (yesterday|tomorrow|other days)|\bother days\b/i.test(message)) {
              try {
                const html = await this._bookingsFallback(message, userContext, userId, userToken);
                if (html) aiResponse = html;
              } catch (e) {}
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
            if (!aiResponse || !String(aiResponse).trim()) {
              aiResponse = userContext.language === 'nl'
                ? 'Ik begrijp het niet helemaal. Vertel in je eigen woorden wat je zoekt—bijvoorbeeld je afspraken bekijken, een salon zoeken, of iets boeken?'
                : "I'm not sure what you need. Tell me in your own words—for example, are you looking to check your appointments, find a salon, or book one?";
            }
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
      const userWantsBookings = /\b(appointment|booking|bookings|plans|agenda|schedule|afspraak|afspraken|boeking|boekingen)\b|do I have|any (plans|appointment)|(my|any) (bookings|appointments)|what about (yesterday|tomorrow|other days)|how about (yesterday|tomorrow|other days)|\bother days\b/i.test(message);
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

      // Ensure we never save or send an empty response (e.g. after genui strip removed everything)
      if (!aiResponse || !String(aiResponse).trim()) {
        aiResponse = userContext?.language === 'nl'
          ? 'Ik begrijp het niet helemaal. Vertel in je eigen woorden wat je zoekt—bijvoorbeeld je afspraken bekijken, een salon zoeken, of iets boeken?'
          : "I'm not sure what you need. Tell me in your own words—for example, are you looking to check your appointments, find a salon, or book one?";
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
