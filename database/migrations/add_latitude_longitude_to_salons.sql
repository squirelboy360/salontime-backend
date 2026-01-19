-- Add latitude and longitude columns to salons table
-- This migration adds geocoding support for distance-based filtering

-- Add latitude and longitude columns if they don't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'salons' 
        AND column_name = 'latitude'
    ) THEN
        ALTER TABLE public.salons 
        ADD COLUMN latitude DECIMAL(10, 8);
        
        COMMENT ON COLUMN public.salons.latitude IS 'Latitude coordinate for geocoding and distance calculations';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'salons' 
        AND column_name = 'longitude'
    ) THEN
        ALTER TABLE public.salons 
        ADD COLUMN longitude DECIMAL(11, 8);
        
        COMMENT ON COLUMN public.salons.longitude IS 'Longitude coordinate for geocoding and distance calculations';
    END IF;
END $$;

-- Create indexes for better query performance on location-based searches
CREATE INDEX IF NOT EXISTS idx_salons_latitude ON public.salons(latitude) WHERE latitude IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_salons_longitude ON public.salons(longitude) WHERE longitude IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_salons_location ON public.salons(latitude, longitude) WHERE latitude IS NOT NULL AND longitude IS NOT NULL;


