const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');

class AIService {
  constructor() {
    // Initialize Gemini AI
    if (config.ai.gemini_api_key) {
      this.genAI = new GoogleGenerativeAI(config.ai.gemini_api_key);
      this.model = this.genAI.getGenerativeModel({ model: config.ai.gemini_model });
    } else {
      this.model = null;
      console.warn('⚠️ Gemini API key not configured - AI features disabled');
    }
  }

  /**
   * Analyze review/comment content for inappropriate content
   * @param {string} content - The review/comment text to analyze
   * @returns {Promise<{flagged: boolean, flagType: string|null, confidence: number, notes: string}>}
   */
  async analyzeReviewContent(content) {
    if (!this.model) {
      // If AI is not configured, return safe default
      return {
        flagged: false,
        flagType: null,
        confidence: 0.0,
        notes: 'AI analysis not available',
      };
    }

    if (!content || content.trim().length === 0) {
      return {
        flagged: false,
        flagType: null,
        confidence: 0.0,
        notes: 'No content to analyze',
      };
    }

    try {
      const prompt = `Analyze the following review/comment for a salon booking app. Check for:
1. Hateful, discriminatory, or offensive language
2. Suicidal or self-harm content
3. Harassment or threats
4. Spam or fake content
5. Inappropriate sexual content
6. Other violations of community guidelines

Be strict but fair. Honest negative feedback is allowed, but hateful or harmful content should be flagged.

Review text: "${content}"

Respond ONLY with valid JSON in this exact format:
{
  "flagged": true/false,
  "flagType": "hateful" | "inappropriate" | "suicidal" | "harassment" | "spam" | "fake" | null,
  "confidence": 0.0-1.0,
  "notes": "Brief explanation of what was detected or why it's safe"
}

If the content is honest feedback (even if negative), set flagged: false. Only flag if there's actual harmful content.`;

      const result = await this.model.generateContent(prompt);
      const responseText = result.response.text();

      // Parse JSON response (handle markdown code blocks if present)
      let jsonText = responseText.trim();
      if (jsonText.startsWith('```json')) {
        jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      } else if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/```\n?/g, '');
      }

      const analysis = JSON.parse(jsonText);

      // Validate response structure
      if (typeof analysis.flagged !== 'boolean') {
        throw new Error('Invalid AI response: flagged must be boolean');
      }

      return {
        flagged: analysis.flagged || false,
        flagType: analysis.flagType || null,
        confidence: Math.max(0.0, Math.min(1.0, parseFloat(analysis.confidence) || 0.0)),
        notes: analysis.notes || 'No issues detected',
      };
    } catch (error) {
      console.error('Error in AI content analysis:', error);
      // Return safe default on error
      return {
        flagged: false,
        flagType: null,
        confidence: 0.0,
        notes: `Analysis error: ${error.message}`,
      };
    }
  }
}

module.exports = new AIService();
