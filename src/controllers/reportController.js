const { supabase, supabaseAdmin } = require('../config/database');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const aiService = require('../services/aiService');

class ReportController {
  // Submit a report for a review
  submitReviewReport = asyncHandler(async (req, res) => {
    const { reviewId } = req.params;
    const { reason, description } = req.body;
    const reporterId = req.user.id;

    if (!reviewId) {
      throw new AppError('Review ID is required', 400, 'MISSING_REVIEW_ID');
    }

    if (!reason) {
      throw new AppError('Report reason is required', 400, 'MISSING_REASON');
    }

    const validReasons = ['spam', 'harassment', 'inappropriate', 'fake', 'hateful', 'suicidal', 'other'];
    if (!validReasons.includes(reason)) {
      throw new AppError('Invalid report reason', 400, 'INVALID_REASON');
    }

    try {
      // Get the review to find the reportee (client who wrote it)
      const { data: review, error: reviewError } = await supabaseAdmin
        .from('reviews')
        .select('client_id')
        .eq('id', reviewId)
        .single();

      if (reviewError || !review) {
        throw new AppError('Review not found', 404, 'REVIEW_NOT_FOUND');
      }

      // Check if user is reporting their own review
      if (review.client_id === reporterId) {
        throw new AppError('You cannot report your own review', 400, 'CANNOT_REPORT_SELF');
      }

      // Check if user already reported this review
      const { data: existingReport, error: existingError } = await supabaseAdmin
        .from('review_reports')
        .select('id')
        .eq('review_id', reviewId)
        .eq('reporter_id', reporterId)
        .maybeSingle();

      if (existingReport) {
        throw new AppError('You have already reported this review', 409, 'REPORT_ALREADY_EXISTS');
      }

      // Create report
      const { data: report, error: reportError } = await supabaseAdmin
        .from('review_reports')
        .insert([{
          review_id: reviewId,
          reporter_id: reporterId,
          reportee_id: review.client_id,
          reason,
          description: description || null,
          status: 'pending',
          ai_flagged: false,
          human_action_required: false,
        }])
        .select('*')
        .single();

      if (reportError) {
        console.error('Error creating report:', reportError);
        throw new AppError('Failed to submit report', 500, 'REPORT_CREATION_FAILED');
      }

      // Trigger AI analysis of the review (async, don't wait)
      this._analyzeReviewWithAI(reviewId).catch(err => {
        console.error('Error in AI analysis:', err);
      });

      res.status(201).json({
        success: true,
        data: {
          report,
        },
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to submit report', 500, 'REPORT_FAILED');
    }
  });

  // AI analysis helper (called asynchronously)
  async _analyzeReviewWithAI(reviewId) {
    try {
      // Get review with comment
      const { data: review, error } = await supabaseAdmin
        .from('reviews')
        .select('comment, rating')
        .eq('id', reviewId)
        .single();

      if (error || !review || !review.comment) {
        return; // No comment to analyze
      }

      // Force re-analysis when manually reported - always analyze to catch missed content
      console.log(`🤖 Forcing AI re-analysis for review ${reviewId} due to manual report`);
      
      const { data: existing } = await supabaseAdmin
        .from('reviews')
        .select('ai_analyzed, ai_flag_type')
        .eq('id', reviewId)
        .single();

      // Always re-analyze on manual reports, even if already analyzed
      // This ensures we catch content that was missed in initial analysis
      if (existing?.ai_analyzed) {
        console.log(`⚠️ Review ${reviewId} was already analyzed (flagged: ${existing?.ai_flag_type || 'no'}), but forcing re-analysis due to manual report`);
      }

      // Use AI service to analyze the comment
      const analysis = await aiService.analyzeReviewContent(review.comment);

      // Update review with AI analysis
      const updateData = {
        ai_analyzed: true,
        updated_at: new Date().toISOString(),
      };

      if (analysis.flagged) {
        updateData.ai_flag_type = analysis.flagType;
        updateData.ai_confidence = analysis.confidence;
        updateData.ai_notes = analysis.notes;
        updateData.is_visible = false; // Hide flagged reviews until human review

        // Create automatic report if AI flags something serious
        if (analysis.flagType === 'hateful' || analysis.flagType === 'suicidal' || analysis.flagType === 'inappropriate') {
          await supabaseAdmin
            .from('review_reports')
            .insert([{
              review_id: reviewId,
              reporter_id: null, // System-generated report
              reportee_id: review.client_id,
              reason: analysis.flagType,
              description: `AI automatically flagged: ${analysis.notes}`,
              status: 'pending',
              ai_flagged: true,
              ai_flag_reason: analysis.notes,
              human_action_required: true, // Always require human review for AI-flagged content
            }]);
        }
      } else {
        updateData.ai_confidence = analysis.confidence || 0.0;
        updateData.ai_notes = analysis.notes || 'No issues detected';
      }

      await supabaseAdmin
        .from('reviews')
        .update(updateData)
        .eq('id', reviewId);

      console.log(`✅ AI analysis completed for review ${reviewId}`);
    } catch (error) {
      console.error('Error in AI analysis:', error);
      // Don't throw - this is async and shouldn't break the report submission
    }
  }
}

module.exports = new ReportController();
