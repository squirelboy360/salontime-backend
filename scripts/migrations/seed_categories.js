require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const categories = [
  { name: 'Hair Salon', slug: 'hair', description: 'Hair cutting, styling, and coloring services', icon: 'scissors', color: '#FF5733' },
  { name: 'Barber', slug: 'barber', description: "Men's grooming and shaving services", icon: 'user', color: '#33FF57' },
  { name: 'Nails', slug: 'nails', description: 'Manicure and pedicure services', icon: 'hand', color: '#3357FF' },
  { name: 'Massage', slug: 'massage', description: 'Therapeutic and relaxing massage services', icon: 'heart', color: '#FF33A1' },
  { name: 'Skincare', slug: 'skincare', description: 'Facials and skin treatments', icon: 'sparkles', color: '#33FFF5' }
];

async function seedCategories() {
  console.log('Seeding categories...');

  // First ensure slug column exists (this is a bit hacky via JS client if we can't run DDL, but we assume the migration SQL was run or we can try to proceed)
  // If the migration SQL wasn't run, this might fail if 'slug' column doesn't exist.
  // But the user asked for a script.

  for (const cat of categories) {
    // Check if exists by slug
    const { data: existing, error } = await supabase
      .from('service_categories')
      .select('id')
      .eq('slug', cat.slug)
      .maybeSingle();

    if (error && error.code === 'PGRST204') { // Column not found? No, that's usually 42703 in Postgres but Supabase might return different.
       console.error('Error checking category. Make sure you ran the SQL migration to add the slug column.', error);
       return;
    }

    if (existing) {
      console.log(`Category ${cat.slug} exists, updating...`);
      const { error: updateError } = await supabase
        .from('service_categories')
        .update(cat)
        .eq('id', existing.id);
      
      if (updateError) console.error(`Failed to update ${cat.slug}:`, updateError);
    } else {
      console.log(`Creating category ${cat.slug}...`);
      const { error: insertError } = await supabase
        .from('service_categories')
        .insert(cat);
      
      if (insertError) console.error(`Failed to insert ${cat.slug}:`, insertError);
    }
  }
  console.log('Categories seeded.');
}

seedCategories();

