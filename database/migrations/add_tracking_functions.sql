-- SQL functions for tracking salon metrics

-- Function to increment salon view count
CREATE OR REPLACE FUNCTION increment_salon_view_count(salon_id_param UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE salons
  SET 
    view_count = COALESCE(view_count, 0) + 1,
    updated_at = NOW()
  WHERE id = salon_id_param;
END;
$$ LANGUAGE plpgsql;

-- Function to increment salon favorite count
CREATE OR REPLACE FUNCTION increment_salon_favorite_count(salon_id_param UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE salons
  SET 
    favorite_count = COALESCE(favorite_count, 0) + 1,
    updated_at = NOW()
  WHERE id = salon_id_param;
END;
$$ LANGUAGE plpgsql;

-- Function to decrement salon favorite count
CREATE OR REPLACE FUNCTION decrement_salon_favorite_count(salon_id_param UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE salons
  SET 
    favorite_count = GREATEST(COALESCE(favorite_count, 0) - 1, 0),
    updated_at = NOW()
  WHERE id = salon_id_param;
END;
$$ LANGUAGE plpgsql;

-- Function to increment salon booking count
CREATE OR REPLACE FUNCTION increment_salon_booking_count(salon_id_param UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE salons
  SET 
    booking_count = COALESCE(booking_count, 0) + 1,
    last_booking_at = NOW(),
    updated_at = NOW()
  WHERE id = salon_id_param;
END;
$$ LANGUAGE plpgsql;

-- Function to calculate and update trending score
-- Call this periodically (e.g., daily via cron)
CREATE OR REPLACE FUNCTION update_salon_trending_score(salon_id_param UUID)
RETURNS VOID AS $$
DECLARE
  recent_views INTEGER;
  recent_bookings INTEGER;
  recent_favorites INTEGER;
  score NUMERIC;
BEGIN
  -- Count recent activity (last 7 days)
  SELECT COUNT(*)
  INTO recent_views
  FROM salon_views
  WHERE salon_id = salon_id_param
    AND viewed_at >= NOW() - INTERVAL '7 days';

  SELECT COUNT(*)
  INTO recent_bookings
  FROM bookings
  WHERE salon_id = salon_id_param
    AND created_at >= NOW() - INTERVAL '7 days';

  SELECT COUNT(*)
  INTO recent_favorites
  FROM user_favorites
  WHERE salon_id = salon_id_param
    AND created_at >= NOW() - INTERVAL '7 days';

  -- Calculate trending score (weighted formula)
  -- Views: 1 point, Bookings: 10 points, Favorites: 5 points
  score := (recent_views * 1.0) + (recent_bookings * 10.0) + (recent_favorites * 5.0);

  -- Update salon
  UPDATE salons
  SET 
    trending_score = score,
    updated_at = NOW()
  WHERE id = salon_id_param;
END;
$$ LANGUAGE plpgsql;

-- Function to update ALL salons' trending scores
-- Call this via cron job daily
CREATE OR REPLACE FUNCTION update_all_salons_trending_scores()
RETURNS VOID AS $$
DECLARE
  salon_record RECORD;
BEGIN
  FOR salon_record IN SELECT id FROM salons WHERE is_active = true
  LOOP
    PERFORM update_salon_trending_score(salon_record.id);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
