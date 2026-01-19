const { GoogleGenerativeAI } = require('@google/generative-ai');
const supabaseService = require('../services/supabaseService');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const config = require('../config');
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
- GET /api/bookings - Get user's bookings (automatically filtered to current user)
- GET /api/salons - Search/browse salons (public, but can filter by user preferences)
- GET /api/services?salon_id={id} - Get services for a salon
- GET /api/favorites - Get user's favorite salons (automatically filtered to current user)
- POST /api/bookings - Create a booking (automatically scoped to current user)
- GET /api/user/profile - Get current user's profile

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
  async getUserContext(userId) {
    try {
      // Get user profile
      const { data: userProfile, error: profileError } = await supabaseService.supabase
        .from('user_profiles')
        .select('id, first_name, last_name, language')
        .eq('id', userId)
        .single();

      if (profileError) {
        console.error('Error fetching user profile:', profileError);
      }

      // Get recent bookings (last 5)
      const { data: recentBookings, error: bookingsError } = await supabaseService.supabase
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
      const { data: favoriteSalons, error: favoritesError } = await supabaseService.supabase
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
        favoriteSalons: favoriteSalons?.map(f => f.salons) || []
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

    if (conversationId) {
      // Get existing conversation
      const { data: conversation, error } = await supabaseService.supabase
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
    const { data: conversation, error } = await supabaseService.supabase
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

    const { data: conversations, error } = await supabaseService.supabase
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

    // Verify conversation belongs to user
    const { data: conversation, error: convError } = await supabaseService.supabase
      .from('ai_conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .single();

    if (convError || !conversation) {
      throw new AppError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
    }

    const { data: messages, error } = await supabaseService.supabase
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
      throw new AppError('AI service is not available', 503, 'AI_SERVICE_UNAVAILABLE');
    }

    const userId = req.user.id;
    const { conversationId, message, newConversation } = req.body;

    if (!message || message.trim().length === 0) {
      throw new AppError('Message is required', 400, 'MESSAGE_REQUIRED');
    }

    let currentConversationId = conversationId;

    // Create new conversation if needed
    if (newConversation || !currentConversationId) {
      const { data: newConv, error: convError } = await supabaseService.supabase
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
      const { data: conversation, error: convError } = await supabaseService.supabase
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
    const { data: userMessage, error: userMsgError } = await supabaseService.supabase
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
    const { data: historyMessages, error: historyError } = await supabaseService.supabase
      .from('ai_messages')
      .select('role, content')
      .eq('conversation_id', currentConversationId)
      .order('created_at', { ascending: true })
      .limit(config.ai.max_conversation_history);

    if (historyError) {
      console.error('Error fetching conversation history:', historyError);
    }

    // Get user context
    const userContext = await this.getUserContext(userId);

    // Build chat history for Gemini
    const chatHistory = [];
    const systemPrompt = this.getSystemPrompt(userContext);

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

    try {
      let chat;
      let aiResponse;
      const userToken = req.token; // Get user's auth token
      
      // If this is the first message, include system prompt in history
      if (chatHistory.length === 0) {
        // First message - include system prompt as initial context
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
          tools: this.getFunctionCallingTools(),
        });
      } else {
        // Continue existing conversation (system prompt already in first message)
        chat = this.model.startChat({
          history: chatHistory,
          generationConfig: {
            maxOutputTokens: config.ai.max_tokens,
            temperature: config.ai.temperature,
          },
          tools: this.getFunctionCallingTools(),
        });
      }

      // Send message and handle function calls
      let result = await chat.sendMessage(message.trim());
      let response = result.response;
      
      // Handle function calls
      while (response.functionCalls && response.functionCalls.length > 0) {
        const functionCalls = response.functionCalls;
        const functionResponses = [];

        for (const functionCall of functionCalls) {
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
      }

      aiResponse = response.text();

      // Save AI response
      const { data: aiMessage, error: aiMsgError } = await supabaseService.supabase
        .from('ai_messages')
        .insert({
          conversation_id: currentConversationId,
          role: 'assistant',
          content: aiResponse,
          metadata: {
            model: config.ai.gemini_model,
            tokens_used: response.usageMetadata?.totalTokenCount || null
          }
        })
        .select()
        .single();

      if (aiMsgError) {
        console.error('Error saving AI message:', aiMsgError);
      }

      // Update conversation updated_at
      await supabaseService.supabase
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
      console.error('Gemini API error:', error);
      
      // Save error message
      const { data: errorMessage } = await supabaseService.supabase
        .from('ai_messages')
        .insert({
          conversation_id: currentConversationId,
          role: 'assistant',
          content: 'I apologize, but I encountered an error processing your request. Please try again.',
          metadata: { error: error.message }
        })
        .select()
        .single();

      throw new AppError(
        'Failed to get AI response',
        500,
        'AI_RESPONSE_ERROR',
        { originalError: error.message }
      );
    }
  });

  // Delete conversation
  deleteConversation = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { conversationId } = req.params;

    // Verify conversation belongs to user
    const { data: conversation, error: convError } = await supabaseService.supabase
      .from('ai_conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .single();

    if (convError || !conversation) {
      throw new AppError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
    }

    // Delete conversation (cascade will delete messages)
    const { error } = await supabaseService.supabase
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

    if (!title || title.trim().length === 0) {
      throw new AppError('Title is required', 400, 'TITLE_REQUIRED');
    }

    // Verify conversation belongs to user
    const { data: conversation, error: convError } = await supabaseService.supabase
      .from('ai_conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .single();

    if (convError || !conversation) {
      throw new AppError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
    }

    const { data: updated, error } = await supabaseService.supabase
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
