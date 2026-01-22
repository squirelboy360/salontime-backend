-- Add Review Reply and Reports Migration
-- Safe to run multiple times

-- =============================================
-- STEP 1: Add owner_reply field to reviews table
-- =============================================

ALTER TABLE public.reviews ADD COLUMN IF NOT EXISTS owner_reply TEXT;
ALTER TABLE public.reviews ADD COLUMN IF NOT EXISTS owner_reply_at TIMESTAMP WITH TIME ZONE;

-- Add comment
COMMENT ON COLUMN public.reviews.owner_reply IS 'Salon owner response to the review';
COMMENT ON COLUMN public.reviews.owner_reply_at IS 'Timestamp when salon owner replied';

-- =============================================
-- STEP 2: Create review_reports table
-- =============================================

CREATE TABLE IF NOT EXISTS public.review_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id UUID NOT NULL REFERENCES public.reviews(id) ON DELETE CASCADE,
    reporter_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    reportee_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL, -- The user who wrote the review/comment
    reason VARCHAR(50) NOT NULL CHECK (reason IN ('spam', 'harassment', 'inappropriate', 'fake', 'hateful', 'suicidal', 'other')),
    description TEXT,
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'resolved', 'dismissed')),
    ai_flagged BOOLEAN DEFAULT false, -- Whether AI automatically flagged this
    ai_flag_reason TEXT, -- What AI detected
    human_action_required BOOLEAN DEFAULT false, -- Whether human review is needed
    admin_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_review_reports_review_id ON public.review_reports(review_id);
CREATE INDEX IF NOT EXISTS idx_review_reports_reporter_id ON public.review_reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_review_reports_status ON public.review_reports(status);
CREATE INDEX IF NOT EXISTS idx_review_reports_human_action ON public.review_reports(human_action_required) WHERE human_action_required = true;

-- Add updated_at trigger
CREATE TRIGGER handle_review_reports_updated_at
    BEFORE UPDATE ON public.review_reports
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- =============================================
-- STEP 3: Add AI analysis fields to reviews table
-- =============================================

ALTER TABLE public.reviews ADD COLUMN IF NOT EXISTS ai_analyzed BOOLEAN DEFAULT false;
ALTER TABLE public.reviews ADD COLUMN IF NOT EXISTS ai_flag_type VARCHAR(50); -- 'hateful', 'inappropriate', 'suicidal', etc.
ALTER TABLE public.reviews ADD COLUMN IF NOT EXISTS ai_confidence DECIMAL(3,2); -- 0.00 to 1.00
ALTER TABLE public.reviews ADD COLUMN IF NOT EXISTS ai_notes TEXT; -- AI's analysis notes
ALTER TABLE public.reviews ADD COLUMN IF NOT EXISTS human_reviewed BOOLEAN DEFAULT false;
ALTER TABLE public.reviews ADD COLUMN IF NOT EXISTS human_review_notes TEXT;

-- Add comments
COMMENT ON COLUMN public.reviews.ai_analyzed IS 'Whether AI has analyzed this review';
COMMENT ON COLUMN public.reviews.ai_flag_type IS 'Type of issue AI detected (if any)';
COMMENT ON COLUMN public.reviews.ai_confidence IS 'AI confidence score (0.00-1.00)';
COMMENT ON COLUMN public.reviews.ai_notes IS 'AI analysis notes';
COMMENT ON COLUMN public.reviews.human_reviewed IS 'Whether a human has reviewed this';
COMMENT ON COLUMN public.reviews.human_review_notes IS 'Human reviewer notes';
