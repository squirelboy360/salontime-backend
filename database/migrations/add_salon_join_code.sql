-- Add join_code to salons for employee invite (unique per salon)
ALTER TABLE public.salons
ADD COLUMN IF NOT EXISTS join_code VARCHAR(12) UNIQUE;

-- Index for fast lookup by join_code
CREATE UNIQUE INDEX IF NOT EXISTS idx_salons_join_code ON public.salons(join_code) WHERE join_code IS NOT NULL;
