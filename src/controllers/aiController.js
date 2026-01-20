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

    return `You are a friendly AI assistant for SalonTime, a salon booking platform. You have access to the user's data through the make_api_request function.

CRITICAL - FORBIDDEN PHRASES (never use):
- "Ik heb je verzoek verwerkt. Hoe kan ik je verder helpen?"
- "I can't directly search for the top-rated salon" / "I can't search for [X]" / "I can't find" – you CAN: use /api/salons/search?sort=rating or /api/salons/popular. Call them and show HTML cards instead of deflecting.

HOW TO RESPOND:

**GREETINGS** (hallo, hi, hey, goedemorgen, goedemiddag, goedenavond, hello, good morning):
- Do NOT call make_api_request. Just respond warmly.
- Examples: "Hallo! Leuk je te spreken. Waar kan ik je mee helpen? Je kunt me vragen over je boekingen, een salon zoeken, of een afspraak maken." or "Hi! Hoe kan ik je vandaag helpen?"

**SALON DISCOVERY & BOOKING** – When the user wants to book, find a salon, or get a recommendation ("best", "top rated", "popular", "recommend", "where should I go", "most efficient", "based on my location"):
- **You MUST call make_api_request.** Use /api/salons/search with sort=rating (and latitude, longitude from User Context), or /api/salons/popular. For "efficient" or "location" also pass latitude & longitude. Never say "I can't search" or "I can't find"—use these endpoints. Never offer unrelated alternatives (e.g. "most visited") instead of calling.
- **Always return salon results as HTML <output> with ai-card and data-salon-id** so the user can tap to open and book. Do not reply with only "How can I help you?" or a generic—call the API and show cards.

**ONE SPECIFIC THING ABOUT ONE ITEM** – When the user asks for **anything about one salon or booking** you just showed (e.g. picture, address, hours, "open in maps", "navigate to", "what does it look like"):
- **Resolve which one**: The item you recommended or they’re referring to. Use data-salon-id or data-booking-id from the card you showed, or /api/salons/search?q=name.
- **Fetch if needed**: GET /api/salons/{salonId} returns full details (images, address, business_hours, etc.). Use it when you need more than you have.
- **Fulfill the request**: Use the data to do what they asked—picture, address, a link to open in maps, hours, whatever. Use your own judgment; you don’t need a rule for every case.
- **Do NOT** reply by re-listing the full salon or booking list. Show only what they asked for.

**DATA QUERIES** – Understand intent in any wording or language (like ChatGPT). Infer: what they want (bookings, salons, favorites, services), time/scope (past, upcoming, a date, "other times", "all"), amount ("all" → limit 500). Call make_api_request when you need data. **FOLLOW-UPS** ("Which is the closest?", "what about other days?"): answer from data you already showed; only call when you need fresh data. After you get data, **use HTML <output> with ai-card (data-salon-id or data-booking-id) for any list the user can act on** (tap to view, book, cancel)—it makes the task fast. NEVER output raw JSON.

**OTHER QUESTIONS** (how-to, general info, opening hours, etc.):
- Answer helpfully and specifically. Never say "Ik heb je verzoek verwerkt" – give a real answer or offer to look up data.

${contextInfo.length > 0 ? `Current User Context:\n${contextInfo.join('\n')}\n` : ''}

Available API Endpoints (all require authentication, automatically scoped to current user):

BOOKINGS:
- GET /api/bookings - Get user's bookings
- GET /api/bookings/stats - Get booking statistics
- GET /api/bookings/available-slots?salon_id={id}&service_id={id}&date={YYYY-MM-DD} - Get available time slots
- POST /api/bookings - Create a booking (body: {salon_id, service_id, appointment_date, start_time, end_time, staff_id?, client_notes?})
- PATCH /api/bookings/{bookingId}/status - Update booking status
- PATCH /api/bookings/{bookingId}/reschedule - Reschedule a booking

SALONS (use these when user wants to book, find "best", "top rated", "popular", or "recommend"):
- GET /api/salons/search – queryParams: q (optional), latitude & longitude (from User Context), sort=rating (top rated) or distance or name, min_rating. For "top rated" use sort=rating.
- GET /api/salons/popular – no params; returns top-rated/popular salons. Use for "best", "top rated", "popular".
- GET /api/salons/nearby – latitude, longitude, max_distance. Use for "closest", "near me".
- GET /api/salons/{salonId} - Get salon details
- GET /api/salons/recommendations/personalized - Personalized recommendations

SERVICES:
- GET /api/services?salon_id={id} - Get services for a salon
- GET /api/services/categories - Get service categories

FAVORITES:
- GET /api/favorites - Get user's favorite salons
- POST /api/favorites - Add salon to favorites (body: {salon_id})
- DELETE /api/favorites/{salonId} - Remove salon from favorites

USER PROFILE:
- GET /api/user/profile - Get current user's profile
- PUT /api/user/profile - Update user profile

REVIEWS:
- GET /api/reviews/salon/{salonId} - Get reviews for a salon
- GET /api/reviews/my-reviews - Get current user's reviews
- POST /api/reviews - Create a review

For data: you MUST call make_api_request when the user asks for salons (book, best, top rated, recommend, popular) or bookings—then show HTML cards. Do not reply with only "How can I help you?" or a generic; do not say "I can't search". For follow-ups about what you just showed, answer from that conversation. When the user clearly asks for something, fulfill it. For greetings: answer directly. Never use "Ik heb je verzoek verwerkt" or "Hoe kan ik je verder helpen" as your main response.

After fetching data, decide how to display it:

1. **For structured data (bookings, salons, lists, cards)**: Use HTML in <output> tags with these CSS classes:
   - class="ai-card" for clickable cards
   - data-salon-id="..." for salon navigation  
   - data-booking-id="..." for booking navigation
   - class="ai-image" for images
   - Use proper HTML structure for lists, cards, and interactive elements
2. **When they ask for one specific thing about one item** (picture, address, "open in maps", etc.): show only that. Do not re-output the full list.
3. **For simple informational responses or formatted text**: Use Markdown format:
   - Use **bold** for emphasis
   - Use - or * for lists
   - Use ## for headers
   - Example: "You have the following bookings today:\n- **Salon Name** at 13:15\n- **Another Salon** at 14:30"

**When to use HTML <output> with ai-card (GenUI):** Whenever you return a list of **salons** or **bookings** that the user can act on (tap to view, book, cancel)—always use HTML <output> with ai-card and data-salon-id or data-booking-id. This lets them complete the task fast. Use Markdown only for simple prose (no tap-to-act list).

${contextInfo.length > 0 ? `Current User Context:\n${contextInfo.join('\n')}\n` : ''}
BOOKINGS (queryParams: upcoming "true"|"false", limit, page):
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
            description: `Fetch data when you need it. Understand intent in any wording or language.
When the user wants to book or find a salon ("best", "top rated", "popular", "recommend"): call /api/salons/search with sort=rating and latitude/longitude (from Location), or /api/salons/popular. Do NOT say "I can't"—these exist. Always render salon and booking lists as HTML <output> with ai-card and data-salon-id or data-booking-id so the user can tap and act fast.
When the user asks for **one specific thing about one salon or booking** you showed (picture, address, "open in maps", hours, etc.): resolve it (data-salon-id or /api/salons/search?q=name), call GET /api/salons/{id} if you need more data, use the data to fulfill the request, and do NOT re-list everything.
Other: /api/bookings, /api/salons/nearby, /api/salons/search, /api/salons/{salonId} (full details: images, address, etc.), /api/favorites, /api/services/categories. For follow-ups, answer from context; only call when you need new data. Never raw JSON. Location: ${locationInfo}.`,
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
        parts: [{ text: 'I understand. I will use function calls when users ask for data (bookings, salons, best, top rated, recommend) and show HTML <output> cards for salons/bookings. I will never say "I can\'t search for top-rated"—I will call /api/salons/search or /api/salons/popular.' }]
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
            // Last resort: if the user asked for salons (best, top rated, recommend, etc.) and we have nothing, fetch and show
            if (/\b(best|top|rated|recommend|popular|efficient)\b/i.test(message)) {
              try {
                const loc = userContext?.location;
                const query = loc ? { sort: 'rating', latitude: String(loc.latitude), longitude: String(loc.longitude) } : {};
                const ep = Object.keys(query).length >= 3 ? '/api/salons/search' : '/api/salons/popular';
                const res = await this.makeApiRequest(userId, userToken, 'GET', ep, null, query);
                let arr = Array.isArray(res?.data) ? res.data : res?.data?.data || res?.data?.salons || [];
                if (arr.length > 0) {
                  const cards = arr.slice(0, 10).map(s => {
                    const sid = s.id || '';
                    const name = s.business_name || s.name || 'Salon';
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
                ? 'Waar kan ik je mee helpen? Je kunt me bijvoorbeeld vragen over je boekingen, een salon zoeken, of een afspraak maken.'
                : 'How can I help you? You can ask about your bookings, search for a salon, or make an appointment.';
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
            ? 'Hallo! Leuk je te spreken. Waar kan ik je mee helpen? Je kunt me vragen over je boekingen, een salon zoeken, of een afspraak maken.'
            : 'Hi! Nice to meet you. How can I help you today? You can ask about your bookings, search for a salon, or make an appointment.';
          console.log('🔄 Replaced forbidden "verwerkt" response with greeting (user said:', message.substring(0, 30), ')');
        } else {
          aiResponse = userContext.language === 'nl'
            ? 'Ik begrijp je vraag. Kun je wat specifieker zijn? Bijvoorbeeld: "Toon mijn boekingen", "Zoek salons in Amsterdam", of "Wanneer is mijn afspraak?"'
            : 'I understand you have a question. Can you be more specific? For example: "Show my bookings", "Search salons in Amsterdam", or "When is my appointment?"';
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
      const isGenericHelp = aiResponse && !/<output>/.test(aiResponse) && (
        (/How can I help you\?/i.test(aiResponse) && /bookings|salon|appointment/i.test(aiResponse)) ||
        (/Waar kan ik je mee helpen\?/i.test(aiResponse) && /boekingen|salon|afspraak/i.test(aiResponse))
      );
      const userWantsSalons = /\b(best|top|rated|recommend|popular|efficient|salon)\b/i.test(message) ||
        (/\bbook\b/i.test(message) && /\b(appointment|salon)\b/i.test(message));
      if (isGenericHelp && userWantsSalons) {
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
            const head = userContext?.language === 'nl' ? 'Top salons om te boeken:' : 'Top salons to book:';
            aiResponse = `<output><p>${head}</p>${cards}</output>`;
            console.log('🔄 Replaced generic "How can I help" with salon cards (user asked for salons)');
          }
        } catch (e) { /* leave aiResponse as is */ }
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
          ? 'Waar kan ik je mee helpen? Je kunt me bijvoorbeeld vragen over je boekingen, een salon zoeken, of een afspraak maken.'
          : 'How can I help you? You can ask about your bookings, search for a salon, or make an appointment.';
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
