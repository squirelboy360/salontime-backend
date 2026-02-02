-- Add availability_schedule to staff so employees can set their own availability.
-- Format: same as business_hours: { "monday": { "opening": "09:00", "closing": "17:00", "closed": false }, ... }
-- If null, staff uses salon opening hours.
ALTER TABLE public.staff
ADD COLUMN IF NOT EXISTS availability_schedule JSONB DEFAULT NULL;

COMMENT ON COLUMN public.staff.availability_schedule IS 'Per-day availability overrides. Null = use salon opening hours.';
