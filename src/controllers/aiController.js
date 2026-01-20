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
      contextInfo.push(`User's current location: ${userContext.location.latitude}, ${userContext.location.longitude}`);
    }
    
    if (userContext.recentBookings && userContext.recentBookings.length > 0) {
      contextInfo.push(`Recent bookings: ${userContext.recentBookings.length} booking(s)`);
    }
    
    if (userContext.favoriteSalons && userContext.favoriteSalons.length > 0) {
      contextInfo.push(`Favorite salons: ${userContext.favoriteSalons.length} salon(s)`);
    }

    return `You are an intelligent, proactive AI assistant for SalonTime, a salon booking platform. Think and act like a helpful human assistant would - be proactive, understand context, and take action to help users.

CRITICAL RULE #1: When a user asks for data (bookings, salons, favorites, etc.), you MUST use the make_api_request function to fetch the data FIRST. However, you should be intelligent about what data to fetch based on the user's question:
- If they ask about "today's bookings" or "vandaag", fetch bookings and filter for today's date in your response
- If they ask about "my bookings", fetch all their bookings
- If they ask for recommendations or "where should I go", fetch nearby salons based on their location
- Understand the context and intent of the question - don't just fetch everything

CRITICAL RULE #2: After fetching data, you MUST:
- Analyze the data intelligently based on what the user asked
- Filter/process the data if needed (e.g., filter for today's date, filter by rating, etc.)
- Generate HTML/CSS to display the RELEVANT data visually
- Wrap the data in <output> tags with HTML cards using the ai-card class
- Provide a natural, contextual response that answers their specific question

NEVER respond with generic text like "Ik heb je verzoek verwerkt" or "I can help" - always provide actual, relevant information based on the data you fetched.

Your personality:
- Proactive: When users ask questions, you IMMEDIATELY fetch the information they need using make_api_request - you don't wait, you don't ask, you just do it
- Context-aware: You understand conversation history and user intent from natural language
- Helpful: You anticipate what users might need and provide complete, actionable information
- Intelligent: You ALWAYS use the available tools (function calling) when you need data - this is how you "look things up"

${contextInfo.length > 0 ? `Current User Context:\n${contextInfo.join('\n')}\n` : ''}

IMPORTANT SECURITY: All API requests you make MUST be scoped to the current logged-in user (userId: ${userContext.userId || 'current_user'}). You CANNOT access data from other users. All requests are automatically authenticated with the user's token.

Available API Endpoints (all require authentication, automatically scoped to current user):

BOOKINGS:
- GET /api/bookings - Get user's bookings (automatically filtered to current user)
- GET /api/bookings/stats - Get booking statistics for current user
- GET /api/bookings/available-slots?salon_id={id}&service_id={id}&date={YYYY-MM-DD} - Get available time slots
- GET /api/bookings/available-slots-count?salon_id={id}&service_id={id}&date={YYYY-MM-DD} - Get count of available slots
- POST /api/bookings - Create a booking (body: {salon_id, service_id, appointment_date, start_time, end_time, staff_id?, client_notes?})
- PATCH /api/bookings/{bookingId}/status - Update booking status (body: {status: 'pending'|'confirmed'|'completed'|'cancelled'|'no_show'})
- PATCH /api/bookings/{bookingId}/reschedule - Reschedule a booking (body: {appointment_date, start_time, end_time})

SALONS:
- GET /api/salons/search?q={query}&lat={lat}&lng={lng}&max_distance={km}&min_rating={0-5}&open_now={true|false}&sort={rating|distance|name} - Search/browse salons
- GET /api/salons/nearby?lat={lat}&lng={lng}&max_distance={km} - Get nearby salons
- GET /api/salons/popular - Get popular salons
- GET /api/salons/{salonId} - Get salon details by ID
- GET /api/salons/recommendations/personalized - Get personalized salon recommendations for current user

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

HOW TO BE A PROACTIVE ASSISTANT:

Think like a human assistant: When someone asks you a question, you naturally:
1. Understand what information they need
2. Go get that information (using make_api_request function)
3. Present it in a helpful, visual way (using GenUI)
4. Provide context and next steps

Examples of natural understanding:
- "show me salons" → You understand they want to see nearby salons → Fetch /api/salons/nearby
- "what are my bookings?" → You understand they want their appointment list → Fetch /api/bookings
- "best salon for haircut" → You understand they want recommendations → Fetch /api/salons/nearby and filter/sort
- "sure" (after asking about salons) → You understand they're confirming → Continue with the salon search

When users ask questions that require data:
1. Naturally use make_api_request to fetch the information - this is like looking something up for them
2. After getting the data, create a visual display using GenUI with the actual data from the response
3. Provide a helpful summary and next steps
4. Never guess or assume - always fetch real data first

ABSOLUTE RULE: If a user asks for data (bookings, salons, favorites, etc.), you MUST call make_api_request BEFORE responding. You CANNOT know if they have bookings or not without checking. You CANNOT say "no bookings" without fetching the data first. This is mandatory - not optional.

Key principle: If you don't have the information to answer a question, you IMMEDIATELY go get it using make_api_request. You never say "I can help" or "no bookings" - you fetch the data first, then respond based on what you actually found.

MANDATORY EXAMPLES:

User: "laat mij alle boekingen zien" or "show me my bookings"
YOU MUST:
1. Call: make_api_request(method: "GET", endpoint: "/api/bookings")
   IMPORTANT: If the response shows pagination (hasMore: true or total > returned count), 
   you MUST make additional requests to get ALL bookings, not just the first page.
   Continue fetching until you have all bookings.
2. Wait for the function response - it will contain the actual booking data
3. Look at response.data - it will be an array of bookings with fields like:
   - salon.business_name or salon_name
   - salon.image_url or salon.images[0] for images
   - service.name or service_name
   - appointment_date
   - start_time, end_time
   - status
4. Include ALL bookings in the GenUI List, not just the first few
4. Generate GenUI using the ACTUAL values from the data. ALWAYS include images when available. Use this structure:
   genui: { 
     command: "beginRendering", 
     surfaceId: "bookings_list", 
     content: { 
       List: { 
         items: [ 
           { 
             Card: { 
               onPressed: {action: "navigate", salonId: "actual_salon_id"}, 
               child: { 
                 Column: { 
                   children: [ 
                     {Image: {url: {literalString: "actual_salon_image_url"}, hint: "medium"}},
                     {Text: {literalString: "actual_salon_name"}}, 
                     {Text: {literalString: "actual_service_name"}}, 
                     {Text: {literalString: "actual_date - actual_time"}}, 
                     {Text: {literalString: "Status: actual_status"}} 
                   ] 
                 } 
               } 
             } 
           } 
         ] 
       } 
     } 
   }
5. IMPORTANT: Always include Image components when data has image_url, images, or avatar_url fields
6. Replace "actual_..." placeholders with REAL values from the function response data
7. Text response: "Hier zijn je boekingen:" followed by the GenUI JSON

       User: "find salons near me" or "vind salons bij mij" or "show me the best salon" or "can u show me based on my location the best salon"
       YOU MUST:
       1. IMMEDIATELY call: make_api_request(method: "GET", endpoint: "/api/salons/nearby", queryParams: {lat: [user_lat], lng: [user_lng], max_distance: "50"})
       2. Wait for the function response - it will contain the actual salon data
       3. Look at response.data.data - it will be an array of salons with fields like:
          - business_name
          - address, city
          - rating_average
          - image_url
          - id
       4. Generate GenUI using the ACTUAL values from the data. ALWAYS include images when available.
       5. Include GenUI JSON in response metadata
       6. NEVER say "I couldn't find any salons" without first calling the API

User: "book an appointment" or "boek een afspraak"
YOU MUST:
1. Call: make_api_request(method: "GET", endpoint: "/api/services?salon_id=[id]")
2. Generate GenUI form with TextField, Button components
3. Include GenUI in metadata

GenUI Components Available:
- Text: {"Text": {"literalString": "text", "hint": "h1|h2|h3|h4|p|small"}}
- Markdown: {"Markdown": {"content": "# markdown content"}}
- Image: {"Image": {"url": {"literalString": "https://example.com/image.jpg"}, "hint": "small|medium|large"}}
- Button: {"Button": {"label": "Click", "onPressed": {"action": "navigate", "salonId": "..."}}}
- Card: {"Card": {"child": {...}, "onPressed": {"action": "navigate", "salonId": "..."}}}
- List: {"List": {"items": [...]}}
- Column: {"Column": {"children": [...], "crossAxisAlignment": "start|center|end"}}
- Row: {"Row": {"children": [...], "mainAxisAlignment": "start|center|end"}}
- TextField: {"TextField": {"placeholder": "...", "path": "data.field"}}
- Container: {"Container": {"child": {...}, "color": "#FF0000", "padding": 16}}

CRITICAL: ALWAYS INCLUDE IMAGES IN GENUI:
- When displaying salons: ALWAYS include Image component using salon.image_url or salon.images[0] from the API response
- When displaying bookings: ALWAYS include Image component using booking.salon.image_url or booking.salon.images[0]
- When displaying favorites: ALWAYS include Image component using favorite.salon.image_url or favorite.salon.images[0]
- Place images FIRST in the Column children array, before text
- Use hint: "medium" for card images

Example Card with image (MANDATORY FORMAT):
{
  "Card": {
    "onPressed": {"action": "navigate", "salonId": "actual_salon_id_from_data"},
    "child": {
      "Column": {
        "children": [
          {"Image": {"url": {"literalString": "actual_image_url_from_data"}, "hint": "medium"}},
          {"Text": {"literalString": "actual_salon_name"}},
          {"Text": {"literalString": "actual_address"}}
        ]
      }
    }
  }
}

If image_url is null or empty, you can skip the Image component, but ALWAYS check for it first.

CORE PRINCIPLES:
- Be proactive: When users ask questions, naturally fetch the information they need
- Be helpful: Present information visually using HTML/CSS so users can see and interact with data
- Be intelligent: Understand context from conversation history and user intent
- Be accurate: Always use real data from API responses, never make assumptions
- Be natural: Respond like a helpful human assistant would - take action, don't just acknowledge

Guidelines:
- When users ask about data (bookings, salons, etc.), naturally use make_api_request to get it
- After fetching data, create visual displays using HTML/CSS with the actual data
- Generate clean, semantic HTML with inline CSS for styling
- Use data attributes for navigation: data-salon-id="..." for salon cards, data-booking-id="..." for booking cards
- Make cards clickable with cursor: pointer style
- Include images using <img> tags with proper src attributes
- Use modern CSS: flexbox, border-radius, padding, margins
- Understand follow-up questions in context (e.g., "sure" after asking about salons means continue)
- Use the user's location when available for location-based queries
- ${userContext.language === 'nl' ? 'Respond in Dutch (Nederlands)' : 'Respond in English'}

HTML OUTPUT FORMAT:
When displaying data, wrap your HTML in <output> tags. Use CSS classes that match shadcn UI design system - DO NOT use inline styles. The following classes are available:

CARDS:
- Use class="ai-card" for clickable cards (salons, bookings, etc.)
- Use data-salon-id="..." for salon navigation
- Use data-booking-id="..." for booking navigation
- Include images with class="ai-image"
- Use <h3> or <h4> for titles (automatically styled)
- Use <p> for descriptions (automatically styled)

BUTTONS:
- Use class="ai-button" for primary buttons
- Use class="ai-button secondary" for secondary buttons

LISTS:
- Use class="ai-list" for list containers
- Use class="ai-list-item" for list items

IMAGES:
- Use class="ai-image" for images (automatically styled with borders and rounded corners)

Example for salon cards:
<output>
<div class="ai-card" data-salon-id="actual_id">
  <img src="actual_image_url" class="ai-image" alt="Salon Name" />
  <h3>Actual Salon Name</h3>
  <p>Actual Address</p>
  <p>Rating: 4.5/5</p>
</div>
</output>

Example for booking cards:
<output>
<div class="ai-card" data-booking-id="actual_id">
  <img src="salon_image_url" class="ai-image" alt="Salon Name" />
  <h3>Service Name</h3>
  <p>Salon: Actual Salon Name</p>
  <p>Date: January 20, 2024 at 2:00 PM</p>
</div>
</output>

Example for buttons:
<output>
<button class="ai-button" data-salon-id="actual_id">Book Now</button>
<button class="ai-button secondary" data-action="view-details">View Details</button>
</output>

CRITICAL: 
- NEVER use inline styles (style="...")
- ALWAYS use the provided CSS classes
- All colors, borders, and spacing are handled by the CSS classes
- Text colors automatically adapt to dark/light mode
- Cards are automatically clickable and styled

Remember: You're an intelligent assistant. When someone asks you something, you naturally go get the information they need and present it helpfully using HTML with the provided CSS classes.`;
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
            description: `Use this function whenever you need to fetch information to answer a user's question. This is your way of "looking things up" - use it naturally whenever you need data. Examples: when users ask about their bookings, want to see salons, need service information, want to check favorites, etc. The user's location is available: ${locationInfo}. All requests are automatically authenticated and scoped to the current user.`,
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
                  description: 'API endpoint path (e.g., /api/bookings, /api/salons, /api/services?salon_id=xxx). Do not include the base URL.'
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
      
      // Only add system prompt for NEW conversations (when history is empty)
      // For existing conversations, the AI should understand from the conversation context
      // Adding system prompt every time disrupts the natural conversation flow
      if (chatHistory.length === 0) {
        // New conversation - add system prompt once
        console.log(`📝 New conversation - adding system prompt`);
        chatHistory.unshift({
          role: 'model',
          parts: [{ text: 'I understand. I will ALWAYS use function calls when users ask for data, and then generate GenUI to display it.' }]
        });
        chatHistory.unshift({
          role: 'user',
          parts: [{ text: systemPrompt }]
        });
      } else {
        console.log(`📝 Existing conversation with ${chatHistory.length} messages - using conversation context`);
      }
      
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
      
        // Minimal safety check: Only force function call if AI gives a generic response without data
        // Let the AI be intelligent and decide when to fetch data naturally
        if ((!currentFunctionCalls || currentFunctionCalls.length === 0)) {
          const responseText = (response.text && typeof response.text === 'function') ? response.text() : (response.text || '');
          const responseLower = responseText.toLowerCase();
          
          // Only force if AI gives a generic "I can help" response without actually helping
          const seemsLikeGenericResponse = 
            (responseLower.includes("verwerkt") && !responseLower.includes("genui") && !responseLower.includes("<output>")) ||
            (responseLower.includes("processed") && !responseLower.includes("genui") && !responseLower.includes("<output>")) ||
            (responseLower.includes("i can help") && !responseLower.includes("genui") && !responseLower.includes("<output>")) ||
            (responseLower.includes("how can i help") && !responseLower.includes("genui") && !responseLower.includes("<output>"));
          
          // Only force as last resort if AI gives generic response
          if (seemsLikeGenericResponse) {
            console.log(`⚠️ AI gave generic response - minimal fallback`);
            const messageLower = message.toLowerCase();
            
            // Only force for very clear data requests
            if (messageLower.includes('booking') || messageLower.includes('boeking')) {
              currentFunctionCalls = [{
                name: 'make_api_request',
                args: {
                  method: 'GET',
                  endpoint: '/api/bookings'
                }
              }];
            } else if ((messageLower.includes('salon') || messageLower.includes('kapper') || messageLower.includes('advies') || messageLower.includes('recommend')) && latitude && longitude) {
              currentFunctionCalls = [{
                name: 'make_api_request',
                args: {
                  method: 'GET',
                  endpoint: '/api/salons/nearby',
                  queryParams: {
                    lat: latitude.toString(),
                    lng: longitude.toString(),
                    max_distance: '50'
                  }
                }
              }];
            }
          }
        }
      
      while (currentFunctionCalls && currentFunctionCalls.length > 0 && functionCallCount < maxFunctionCallIterations) {
        functionCallCount++;
        const functionResponses = [];

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
          // Store the last function response data for GenUI generation
          const lastResponseData = functionResponses[functionResponses.length - 1]?.functionResponse?.response?.data;
          
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
              // Force HTML generation with the actual data
              const messageLower = message.toLowerCase();
              let htmlPrompt = '';
              
              // Safely extract array data from response
              let dataArray = [];
              if (Array.isArray(lastResponseData)) {
                dataArray = lastResponseData;
              } else if (lastResponseData && typeof lastResponseData === 'object') {
                // Try different possible structures
                if (Array.isArray(lastResponseData.data)) {
                  dataArray = lastResponseData.data;
                } else if (Array.isArray(lastResponseData.bookings)) {
                  dataArray = lastResponseData.bookings;
                } else if (Array.isArray(lastResponseData.salons)) {
                  dataArray = lastResponseData.salons;
                } else if (lastResponseData.success && Array.isArray(lastResponseData.data)) {
                  dataArray = lastResponseData.data;
                }
              }
              
              // Ensure we have an array before using slice
              const safeArray = Array.isArray(dataArray) ? dataArray : [];
              const limitedData = safeArray.slice(0, 5);
              
              // Let the AI intelligently filter and process the data based on the original question
              const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
              const isTodayQuery = messageLower.includes('vandaag') || messageLower.includes('today') || messageLower.includes('today\'s') || messageLower.includes('gepland');
              
              if (messageLower.includes('booking') || messageLower.includes('boeking')) {
                if (isTodayQuery) {
                  // Filter for today's bookings
                  const todayBookings = safeArray.filter(booking => {
                    const bookingDate = booking.appointment_date || booking.date || booking.appointmentDate;
                    return bookingDate && bookingDate.startsWith(today);
                  });
                  htmlPrompt = `De gebruiker vroeg: "${message}". Je hebt alle boekingen opgehaald, maar de gebruiker wil ALLEEN boekingen voor VANDAAG (${today}). Filter de data en toon ALLEEN boekingen waar appointment_date begint met "${today}". Maak HTML cards met class="ai-card" en data-booking-id. Gebruik deze GEFILTERDE data: ${JSON.stringify(todayBookings.slice(0, 10))}. Wrap in <output> tags. Geef een natuurlijk antwoord zoals "Je hebt X boekingen vandaag" en toon ALLEEN vandaag's boekingen, NIET alle boekingen.`;
                } else {
                  htmlPrompt = `De gebruiker vroeg: "${message}". Je hebt boekingen opgehaald. Analyseer de vraag en toon alleen de relevante boekingen. Maak HTML cards met class="ai-card" en data-booking-id. Gebruik deze data: ${JSON.stringify(limitedData)}. Wrap in <output> tags. Geef een natuurlijk, contextueel antwoord dat de vraag beantwoordt.`;
                }
              } else if (messageLower.includes('salon') || messageLower.includes('kapper')) {
                htmlPrompt = `De gebruiker vroeg: "${message}". Je hebt salons opgehaald. Analyseer de vraag en toon alleen de relevante salons. Maak HTML cards met class="ai-card" en data-salon-id. Gebruik deze data: ${JSON.stringify(limitedData)}. Wrap in <output> tags. Geef een natuurlijk, contextueel antwoord dat de vraag beantwoordt.`;
              } else if (messageLower.includes('favorit') || messageLower.includes('favorite')) {
                htmlPrompt = `De gebruiker vroeg: "${message}". Je hebt favorieten opgehaald. Maak HTML cards met class="ai-card" en data-salon-id. Gebruik deze data: ${JSON.stringify(limitedData)}. Wrap in <output> tags. Geef een natuurlijk antwoord.`;
              } else {
                htmlPrompt = `De gebruiker vroeg: "${message}". Je hebt data opgehaald. Analyseer de vraag en toon alleen relevante data. Maak HTML cards met class="ai-card". Gebruik deze data: ${JSON.stringify(limitedData)}. Wrap in <output> tags. Geef een natuurlijk, contextueel antwoord dat de vraag beantwoordt.`;
              }
              
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
      try {
        if (typeof response.text === 'function') {
          aiResponse = response.text();
        } else if (response.text && typeof response.text === 'string') {
          aiResponse = response.text;
        }
      } catch (e) {
        // Continue to try other methods
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
      
      // If still no response after function calls, the model might need a follow-up
      if (!aiResponse || aiResponse.trim().length === 0) {
        if (functionCallCount > 0) {
          // Function calls completed but no text response - request a summary with GenUI
          try {
            const messageLower = message.toLowerCase();
            let followUpPrompt = '';
            
            if (messageLower.includes('booking') || messageLower.includes('boeking')) {
              followUpPrompt = 'Je hebt de boekingen opgehaald. Geef nu een samenvatting in het Nederlands en genereer GenUI JSON om ze in een lijst weer te geven. Gebruik het beginRendering commando met een List component met Card items voor elke booking. Gebruik de exacte data die je hebt ontvangen.';
            } else if (messageLower.includes('salon') || messageLower.includes('kapper')) {
              followUpPrompt = 'Je hebt de salons opgehaald. Geef nu een samenvatting in het Nederlands en genereer GenUI JSON om ze in een lijst weer te geven. Gebruik de exacte data die je hebt ontvangen.';
            } else {
              followUpPrompt = 'Je hebt de data opgehaald. Geef nu een samenvatting en genereer GenUI JSON om de data visueel weer te geven. Gebruik de exacte data die je hebt ontvangen.';
            }
            
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
          } catch (e) {
            // If follow-up fails, provide a helpful default message based on the request
            const messageLower = message.toLowerCase();
            if (messageLower.includes('booking') || messageLower.includes('boeking')) {
              aiResponse = 'Ik heb je boekingen opgehaald. Hier zijn ze:';
            } else {
              aiResponse = 'Ik heb de informatie opgehaald. Hoe wil je dat ik het presenteer?';
            }
          }
        } else {
          // No function calls but still empty - provide a default response
          aiResponse = 'Ik heb je verzoek verwerkt. Hoe kan ik je verder helpen?';
        }
      }

      // Check if response contains GenUI/A2UI commands
      // The AI might include GenUI commands in its response
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
        // If parsing fails, continue without GenUI
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

      res.json({
        success: true,
        conversationId: currentConversationId,
        userMessage: userMessage,
        aiMessage: aiMessage || {
          id: null,
          role: 'assistant',
          content: aiResponse,
          created_at: new Date().toISOString()
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
