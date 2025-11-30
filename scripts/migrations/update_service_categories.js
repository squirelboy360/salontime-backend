require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function updateServiceCategories() {
  console.log('Starting service category update...');

  // 1. Fetch categories
  const { data: categories, error: catError } = await supabase
    .from('service_categories')
    .select('*');

  if (catError) {
    console.error('Error fetching categories:', catError);
    return;
  }

  const categoryMap = {};
  categories.forEach(cat => {
    if (cat.slug) {
      categoryMap[cat.slug] = cat.id;
    }
  });

  console.log('Categories found:', Object.keys(categoryMap));

  if (Object.keys(categoryMap).length === 0) {
    console.error('No categories found with slugs. Please run the SQL migration first.');
    return;
  }

  // 2. Fetch all services
  const { data: services, error: servError } = await supabase
    .from('services')
    .select('*');

  if (servError) {
    console.error('Error fetching services:', servError);
    return;
  }

  console.log(`Found ${services.length} services to process.`);

  // 3. Update services
  let updatedCount = 0;
  for (const service of services) {
    let categoryId = null;
    const name = service.name.toLowerCase();
    const desc = (service.description || '').toLowerCase();

    if (name.includes('hair') || name.includes('cut') || name.includes('color') || name.includes('blow') || desc.includes('hair')) {
      categoryId = categoryMap['hair'];
    } else if (name.includes('shave') || name.includes('beard') || name.includes('trim') || desc.includes('barber')) {
      categoryId = categoryMap['barber'];
    } else if (name.includes('nail') || name.includes('manicure') || name.includes('pedicure') || desc.includes('nail')) {
      categoryId = categoryMap['nails'];
    } else if (name.includes('massage') || name.includes('therapy') || desc.includes('massage')) {
      categoryId = categoryMap['massage'];
    } else if (name.includes('skin') || name.includes('facial') || desc.includes('skin')) {
      categoryId = categoryMap['skincare'];
    } else {
      // Default to hair if unsure
      categoryId = categoryMap['hair'];
    }

    if (categoryId) {
      const { error: updateError } = await supabase
        .from('services')
        .update({ category_id: categoryId })
        .eq('id', service.id);

      if (updateError) {
        console.error(`Failed to update service ${service.id}:`, updateError);
      } else {
        updatedCount++;
        process.stdout.write('.');
      }
    }
  }

  console.log(`\nUpdated ${updatedCount} services.`);
}

updateServiceCategories();

