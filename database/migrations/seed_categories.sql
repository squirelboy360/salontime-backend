-- Add slug column if it doesn't exist
ALTER TABLE public.service_categories ADD COLUMN IF NOT EXISTS slug text;

-- Add unique constraint if it doesn't exist (this is a bit tricky in pure SQL without PL/pgSQL, but for now let's assume we can add it or it might fail if duplicates exist)
-- We'll try to add it, if it fails it might be because of duplicates or it already exists.
-- For safety in a script, we usually check first. But here I'll just add the column and insert.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_categories_slug_key') THEN
        ALTER TABLE public.service_categories ADD CONSTRAINT service_categories_slug_key UNIQUE (slug);
    END IF;
END $$;

-- Insert categories
INSERT INTO public.service_categories (name, slug, description, icon, color, is_active)
VALUES
  ('Hair Salon', 'hair', 'Hair cutting, styling, and coloring services', 'scissors', '#FF5733', true),
  ('Barber', 'barber', 'Men''s grooming and shaving services', 'user', '#33FF57', true),
  ('Nails', 'nails', 'Manicure and pedicure services', 'hand', '#3357FF', true),
  ('Massage', 'massage', 'Therapeutic and relaxing massage services', 'heart', '#FF33A1', true),
  ('Skincare', 'skincare', 'Facials and skin treatments', 'sparkles', '#33FFF5', true)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  color = EXCLUDED.color;

