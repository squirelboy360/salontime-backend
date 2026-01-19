const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const { authenticateToken } = require('../middleware/auth');

// All AI routes require authentication
router.use(authenticateToken);

// Get or create conversation
router.post('/conversations', aiController.getOrCreateConversation);

// Get all conversations for user
router.get('/conversations', aiController.getConversations);

// Get messages for a conversation
router.get('/conversations/:conversationId/messages', aiController.getMessages);

// Send message to AI
router.post('/conversations/:conversationId/messages', aiController.sendMessage);

// Send message (creates new conversation if needed)
router.post('/messages', aiController.sendMessage);

// Update conversation title
router.patch('/conversations/:conversationId/title', aiController.updateConversationTitle);

// Delete conversation
router.delete('/conversations/:conversationId', aiController.deleteConversation);

module.exports = router;
