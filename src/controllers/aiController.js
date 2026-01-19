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
      console.warn('⚠️  GEMINI_API_KEY not set. AI features will be disabled.');
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

    return `You are a helpful AI assistant for SalonTime, a salon booking platform. Your role is to help users find salons, book appointments, and answer questions about salon services.

${contextInfo.length > 0 ? `User Context:\n${contextInfo.join('\n')}\n` : ''}

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

When you need to make API calls:
1. Use the "make_api_request" function tool to call these endpoints
2. The request will automatically include the user's authentication token
3. All responses are automatically scoped to the current user (userId: ${userContext.userId || 'current_user'})
4. If a request fails or returns no data, explain this to the user
5. After getting API data, present it in a helpful, readable format

When you cannot fulfill a request via API or when the user asks for dynamic UI:
- Use GenUI (A2UI) format to generate dynamic Flutter UI components
- You can generate: Text, Markdown, Image, Button, TextField, Card, List, etc.
- Use the beginRendering command to create new UI surfaces
- Use surfaceUpdate to update existing surfaces
- Use dataModelUpdate to update the data model that widgets are bound to
- Example: If user asks "show me my bookings in a list", first call the API to get bookings, then generate a List UI component with the data

Guidelines:
- Be friendly, professional, and helpful
- Help users find salons based on their preferences (location, services, ratings, etc.)
- When users ask about their bookings, use the API to fetch real data
- When users want to see salon details, use the API to fetch real data
- When you need to show complex data or forms, use GenUI to generate appropriate UI
- Provide recommendations based on user preferences and history
- If you don't know something, suggest the user check the app or contact support
- Keep responses concise and actionable
- ${userContext.language === 'nl' ? 'Respond in Dutch (Nederlands)' : 'Respond in English'}

Remember: You have access to real user data through API calls. Use this to provide accurate, personalized assistance.`;
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
      console.error('API request error:', error);
      throw error;
    }
  }

  // Get function calling tools for Gemini
  getFunctionCallingTools() {
    // Gemini API v0.24.1 expects tools as an array
    return [
      {
        functionDeclarations: [
          {
            name: 'make_api_request',
            description: 'Make an authenticated API request on behalf of the current user. All requests are automatically scoped to the logged-in user. Use this to fetch user data like bookings, salons, services, favorites, etc.',
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

      if (profileError) {
        console.error('Error fetching user profile:', profileError);
      }

      // Get recent bookings (last 5)
      const { data: recentBookings, error: bookingsError } = await client
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

      if (bookingsError) {
        console.error('Error fetching recent bookings:', bookingsError);
      }

      // Get favorite salons
      const { data: favoriteSalons, error: favoritesError } = await client
        .from('user_favorites')
        .select(`
          salons:salon_id(business_name, city, rating_average)
        `)
        .eq('user_id', userId)
        .limit(10);

      if (favoritesError) {
        console.error('Error fetching favorite salons:', favoritesError);
      }

      return {
        userId: userId,
        name: userProfile ? `${userProfile.first_name} ${userProfile.last_name}` : null,
        language: userProfile?.language || 'en',
        recentBookings: recentBookings || [],
        favoriteSalons: favoriteSalons?.map(f => f.salons) || [],
        location: (latitude && longitude) ? { latitude, longitude } : null
      };
    } catch (error) {
      console.error('Error getting user context:', error);
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
    console.log('🤖 sendMessage called');
    console.log('🤖 Model initialized:', !!this.model);
    console.log('🤖 GEMINI_API_KEY set:', !!config.ai.gemini_api_key);
    
    if (!this.model) {
      console.error('❌ AI model not initialized');
      throw new AppError('AI service is not available. GEMINI_API_KEY may not be set.', 503, 'AI_SERVICE_UNAVAILABLE');
    }

    const userId = req.user.id;
    const { conversationId, message, newConversation, latitude, longitude } = req.body;

    console.log('🤖 Request params:', { userId, conversationId, message: message?.substring(0, 50), newConversation, latitude, longitude });

    if (!message || message.trim().length === 0) {
      throw new AppError('Message is required', 400, 'MESSAGE_REQUIRED');
    }

    let currentConversationId = conversationId;

    // Use authenticated client for RLS
    const authenticatedClient = getAuthenticatedClient(req.token);
    
    // Create new conversation if needed
    if (newConversation || !currentConversationId) {
      const { data: newConv, error: convError } = await authenticatedClient
        .from('ai_conversations')
        .insert({
          user_id: userId,
          title: message.substring(0, 50) // Use first 50 chars as title
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
    const { data: historyMessages, error: historyError } = await authenticatedClient
      .from('ai_messages')
      .select('role, content')
      .eq('conversation_id', currentConversationId)
      .order('created_at', { ascending: true })
      .limit(config.ai.max_conversation_history);

    if (historyError) {
      console.error('Error fetching conversation history:', historyError);
    }

    // Get user context with location
    const userContext = await this.getUserContext(userId, req.token, latitude, longitude);

    // Build chat history for Gemini
    const chatHistory = [];
    const systemPrompt = this.getSystemPrompt(userContext);

    console.log('🤖 Building chat history');
    console.log('🤖 History messages count:', historyMessages?.length || 0);

    // Add conversation history
    if (historyMessages && historyMessages.length > 0) {
      historyMessages.forEach(msg => {
        if (msg.role === 'user' || msg.role === 'assistant') {
          chatHistory.push({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
          });
        }
      });
    }

    console.log('🤖 Chat history length:', chatHistory.length);
    console.log('🤖 System prompt length:', systemPrompt.length);

    try {
      let chat;
      let aiResponse;
      const userToken = req.token; // Get user's auth token
      
      const tools = this.getFunctionCallingTools();
      console.log('🤖 Function calling tools:', JSON.stringify(tools, null, 2));
      
      // If this is the first message, include system prompt in history
      if (chatHistory.length === 0) {
        console.log('🤖 Starting new chat with system prompt');
        // First message - include system prompt as initial context
        try {
          chat = this.model.startChat({
            history: [
              {
                role: 'user',
                parts: [{ text: systemPrompt }]
              },
              {
                role: 'model',
                parts: [{ text: 'I understand. I\'m ready to help you with salon bookings and questions. How can I assist you today?' }]
              }
            ],
            generationConfig: {
              maxOutputTokens: config.ai.max_tokens,
              temperature: config.ai.temperature,
            },
            tools: tools,
          });
          console.log('✅ Chat started successfully');
        } catch (chatError) {
          console.error('❌ Error starting chat:', chatError);
          throw chatError;
        }
      } else {
        console.log('🤖 Continuing existing conversation');
        // Continue existing conversation (system prompt already in first message)
        try {
          chat = this.model.startChat({
            history: chatHistory,
            generationConfig: {
              maxOutputTokens: config.ai.max_tokens,
              temperature: config.ai.temperature,
            },
            tools: tools,
          });
          console.log('✅ Chat started successfully');
        } catch (chatError) {
          console.error('❌ Error starting chat:', chatError);
          throw chatError;
        }
      }

      console.log('🤖 Sending message to Gemini:', message.trim().substring(0, 100));
      
      // Send message and handle function calls
      let result;
      try {
        result = await chat.sendMessage(message.trim());
        console.log('✅ Message sent, got result');
      } catch (sendError) {
        console.error('❌ Error sending message:', sendError);
        throw sendError;
      }
      
      let response = result.response;
      console.log('🤖 Response received, type:', typeof response);
      console.log('🤖 Response keys:', response ? Object.keys(response) : 'null');
      
      // Handle function calls - check both functionCalls and functionCall (singular)
      let currentFunctionCalls = response.functionCalls || (response.functionCall ? [response.functionCall] : []);
      
      while (currentFunctionCalls && currentFunctionCalls.length > 0) {
        const functionResponses = [];

        for (const functionCall of currentFunctionCalls) {
          if (functionCall.name === 'make_api_request') {
            try {
              const { method, endpoint, body, queryParams } = functionCall.args;
              console.log(`🤖 AI making API request: ${method} ${endpoint}`);
              
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
              console.error('Function call error:', error);
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
        result = await chat.sendMessage(functionResponses);
        response = result.response;
        // Update currentFunctionCalls for next iteration
        currentFunctionCalls = response.functionCalls || (response.functionCall ? [response.functionCall] : []);
      }

      // Get text response - handle different response formats
      if (typeof response.text === 'function') {
        aiResponse = response.text();
      } else if (response.text) {
        aiResponse = response.text;
      } else if (response.candidates && response.candidates[0] && response.candidates[0].content) {
        // Handle alternative response format
        const parts = response.candidates[0].content.parts || [];
        aiResponse = parts.map(part => part.text || '').join('');
      } else {
        console.error('❌ Unexpected response format:', JSON.stringify(response, null, 2));
        throw new Error('Unexpected response format from Gemini API');
      }
      
      if (!aiResponse || aiResponse.trim().length === 0) {
        console.error('❌ Empty response from Gemini');
        throw new Error('Empty response from AI model');
      }
      
      console.log('✅ AI response received:', aiResponse.substring(0, 100) + '...');

      // Check if response contains GenUI/A2UI commands
      // The AI might include GenUI commands in its response
      let genuiMetadata = null;
      try {
        // Try to parse GenUI commands from response
        // Format: The AI can include JSON in its response that we'll extract
        const genuiMatch = aiResponse.match(/```json\s*({[\s\S]*?})\s*```/);
        if (genuiMatch) {
          const genuiJson = JSON.parse(genuiMatch[1]);
          if (genuiJson.command || genuiJson.surfaceId) {
            genuiMetadata = { genui: genuiJson };
            // Remove GenUI JSON from text response
            aiResponse = aiResponse.replace(/```json\s*{[\s\S]*?}\s*```/g, '').trim();
          }
        }
      } catch (e) {
        // If parsing fails, continue without GenUI
        console.log('Could not parse GenUI from response:', e);
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

      if (aiMsgError) {
        console.error('Error saving AI message:', aiMsgError);
      }

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
      console.error('❌ Gemini API error:', error);
      console.error('❌ Error stack:', error.stack);
      console.error('❌ Error details:', {
        message: error.message,
        name: error.name,
        code: error.code,
        cause: error.cause,
        response: error.response
      });
      
      // Check if model is initialized
      if (!this.model) {
        console.error('❌ Gemini model not initialized - check GEMINI_API_KEY');
        throw new AppError(
          'AI service is not available. Please check server configuration.',
          503,
          'AI_SERVICE_UNAVAILABLE'
        );
      }
      
      // Save error message
      try {
        const authenticatedClient = getAuthenticatedClient(req.token);
        const { data: errorMessage } = await authenticatedClient
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
        console.error('❌ Failed to save error message:', saveError);
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
