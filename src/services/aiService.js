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

    // Safety check: Look for obvious harmful phrases before AI analysis
    const contentLower = content.toLowerCase();
    const harmfulPatterns = {
      suicidal: [
        'sucide', 'suicide', 'kill yourself', 'end your life', 'should die', 
        'should sucide', 'should suicide', 'you should die', 'go die',
        'kill yourself', 'end it', 'off yourself', 'harm yourself'
      ],
      hateful: [
        'disgusting', 'ugly', 'hate', 'stupid', 'idiot', 'moron', 'retard'
      ],
      harassment: [
        'fuck you', 'fuck off', 'asshole', 'bitch', 'bastard'
      ]
    };

    // Check for obvious harmful content
    for (const [flagType, patterns] of Object.entries(harmfulPatterns)) {
      for (const pattern of patterns) {
        if (contentLower.includes(pattern)) {
          console.log(`🚨 Safety check flagged content as ${flagType} due to pattern: "${pattern}"`);
          return {
            flagged: true,
            flagType: flagType,
            confidence: 0.9,
            notes: `Automatically flagged due to harmful content: "${pattern}"`,
          };
        }
      }
    }

    try {
      console.log(`🤖 AI analyzing review content: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);
      
      const prompt = `Analyze the following review/comment for a salon booking app. Check for:
1. Hateful, discriminatory, or offensive language
2. Suicidal or self-harm content (including variations like "sucide", "suicide", "kill yourself", "end your life", "should die", etc.)
3. Harassment or threats
4. Spam or fake content
5. Inappropriate sexual content
6. Other violations of community guidelines

**CRITICAL**: Be VERY strict about harmful content. Flag ANY mention of:
- Suicide, self-harm, or death wishes (including typos like "sucide", "should sucide", "should die", "kill yourself", etc.)
- Hateful language or discrimination
- Threats or harassment
- Inappropriate sexual content

Be strict but fair. Honest negative feedback is allowed, but hateful or harmful content MUST be flagged.

Review text: "${content}"

Respond ONLY with valid JSON in this exact format:
{
  "flagged": true/false,
  "flagType": "hateful" | "inappropriate" | "suicidal" | "harassment" | "spam" | "fake" | null,
  "confidence": 0.0-1.0,
  "notes": "Brief explanation of what was detected or why it's safe"
}

**IMPORTANT**: If the text contains ANY mention of suicide, death wishes, or telling someone to harm themselves (even with typos), you MUST set flagged: true and flagType: "suicidal" with high confidence (0.8+).`;

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

      const analysisResult = {
        flagged: analysis.flagged || false,
        flagType: analysis.flagType || null,
        confidence: Math.max(0.0, Math.min(1.0, parseFloat(analysis.confidence) || 0.0)),
        notes: analysis.notes || 'No issues detected',
      };
      
      console.log(`🤖 AI analysis result for review: flagged=${analysisResult.flagged}, type=${analysisResult.flagType}, confidence=${analysisResult.confidence}`);
      
      return analysisResult;
    } catch (error) {
      console.error('❌ Error in AI content analysis:', error);
      console.error('❌ Content that failed analysis:', content);
      // Return safe default on error - but log it so we know AI failed
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
