const { asyncHandler, AppError } = require('../middleware/errorHandler');
const { supabase } = require('../config/database');

class ServiceController {
  // Get all services for a salon
  getSalonServices = asyncHandler(async (req, res) => {
    const { page = 1, limit = 20 } = req.query;

    try {
      // Get user's salon
      const { data: salon, error: salonError } = await supabase
        .from('salons')
        .select('id')
        .eq('owner_id', req.user.id)
        .single();

      if (salonError || !salon) {
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      const salonId = salon.id;
      const offset = (page - 1) * limit;

      const { data: services, error } = await supabase
        .from('services')
        .select(`
          *,
          category:service_categories(*)
        `)
        .eq('salon_id', salonId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        throw new AppError('Failed to fetch services', 500, 'FETCH_FAILED');
      }

      res.status(200).json({
        success: true,
        data: {
          services,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit)
          }
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to fetch services', 500, 'FETCH_FAILED');
    }
  });

  // Create a new service
  createService = asyncHandler(async (req, res) => {
    const { name, description, price, duration, category_id, is_active = true } = req.body;

    // Validate required fields
    if (!name || name.trim() === '') {
      throw new AppError('Service name is required', 400, 'VALIDATION_ERROR');
    }
    if (!price || isNaN(parseFloat(price))) {
      throw new AppError('Valid price is required', 400, 'VALIDATION_ERROR');
    }
    if (!duration || isNaN(parseInt(duration)) || parseInt(duration) <= 0) {
      throw new AppError('Valid duration is required', 400, 'VALIDATION_ERROR');
    }

    // Get user's salon
    const { data: salon, error: salonError } = await supabase
      .from('salons')
      .select('id')
      .eq('owner_id', req.user.id)
      .single();

    if (salonError || !salon) {
      console.error('❌ Salon lookup error:', salonError);
      console.error('❌ User ID:', req.user.id);
      throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
    }

    const salonId = salon.id;
    console.log('✅ Found salon ID:', salonId, 'for user:', req.user.id);

    try {
      // Convert empty string category_id to null
      const finalCategoryId = (category_id && category_id.trim() !== '') ? category_id : null;
      const finalDescription = (description && description.trim() !== '') ? description : null;
      
      console.log('📝 Creating service with:', {
        salon_id: salonId,
        name,
        price: parseFloat(price),
        duration: parseInt(duration),
        category_id: finalCategoryId,
        is_active
      });
      
      const { data: service, error } = await supabase
        .from('services')
        .insert({
          salon_id: salonId,
          name: name.trim(),
          description: finalDescription,
          price: parseFloat(price),
          duration: parseInt(duration),
          category_id: finalCategoryId,
          is_active
        })
        .select(`
          *,
          category:service_categories(*)
        `)
        .single();

      if (error) {
        console.error('❌ Service creation error:', error);
        console.error('❌ Error code:', error.code);
        console.error('❌ Error message:', error.message);
        console.error('❌ Error details:', JSON.stringify(error, null, 2));
        console.error('❌ Error hint:', error.hint);
        throw new AppError(`Failed to create service: ${error.message || JSON.stringify(error)}`, 500, 'CREATE_FAILED');
      }

      res.status(201).json({
        success: true,
        data: { service }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      console.error('❌ Service creation unexpected error:', error);
      console.error('❌ Error stack:', error.stack);
      throw new AppError(`Failed to create service: ${error.message || JSON.stringify(error)}`, 500, 'CREATE_FAILED');
    }
  });

  // Update a service
  updateService = asyncHandler(async (req, res) => {
    const { serviceId } = req.params;
    const { name, description, price, duration, category_id, is_active } = req.body;

    // Get user's salon
    const { data: salon, error: salonError } = await supabase
      .from('salons')
      .select('id')
      .eq('owner_id', req.user.id)
      .single();

    if (salonError || !salon) {
      throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
    }

    const salonId = salon.id;

    try {
      const updateData = {};
      if (name !== undefined) updateData.name = name;
      if (description !== undefined) {
        updateData.description = (description && description.trim() !== '') ? description : null;
      }
      if (price !== undefined) updateData.price = parseFloat(price);
      if (duration !== undefined) updateData.duration = parseInt(duration);
      if (category_id !== undefined) {
        updateData.category_id = (category_id && category_id.trim() !== '') ? category_id : null;
      }
      if (is_active !== undefined) updateData.is_active = is_active;

      console.log('📝 Updating service:', serviceId, 'with data:', updateData);
      console.log('📝 Salon ID:', salonId);
      
      const { data: service, error } = await supabase
        .from('services')
        .update(updateData)
        .eq('id', serviceId)
        .eq('salon_id', salonId)
        .select(`
          *,
          category:service_categories(*)
        `)
        .single();

      if (error || !service) {
        console.error('❌ Service update error:', error);
        console.error('❌ Service ID:', serviceId, 'Salon ID:', salonId);
        console.error('❌ Update data:', updateData);
        if (error) {
          console.error('❌ Error code:', error.code);
          console.error('❌ Error message:', error.message);
          console.error('❌ Error hint:', error.hint);
          throw new AppError(`Service update failed: ${error.message || JSON.stringify(error)}`, 404, 'SERVICE_NOT_FOUND');
        }
        // Check if service exists but doesn't belong to this salon
        const { data: existingService } = await supabase
          .from('services')
          .select('id, salon_id')
          .eq('id', serviceId)
          .single();
        if (existingService) {
          console.error('❌ Service exists but salon_id mismatch:', existingService.salon_id, 'vs', salonId);
        } else {
          console.error('❌ Service does not exist:', serviceId);
        }
        throw new AppError('Service not found or update failed', 404, 'SERVICE_NOT_FOUND');
      }

      res.status(200).json({
        success: true,
        data: { service }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to update service', 500, 'UPDATE_FAILED');
    }
  });

  // Delete a service
  deleteService = asyncHandler(async (req, res) => {
    const { serviceId } = req.params;

    // Get user's salon
    const { data: salon, error: salonError } = await supabase
      .from('salons')
      .select('id')
      .eq('owner_id', req.user.id)
      .single();

    if (salonError || !salon) {
      throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
    }

    const salonId = salon.id;

    try {
      const { error } = await supabase
        .from('services')
        .delete()
        .eq('id', serviceId)
        .eq('salon_id', salonId);

      if (error) {
        throw new AppError('Failed to delete service', 500, 'DELETE_FAILED');
      }

      res.status(200).json({
        success: true,
        message: 'Service deleted successfully'
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to delete service', 500, 'DELETE_FAILED');
    }
  });

  // Get service categories
  getServiceCategories = asyncHandler(async (req, res) => {
    try {
      const { data: categories, error } = await supabase
        .from('service_categories')
        .select('*')
        .order('name');

      if (error) {
        throw new AppError('Failed to fetch categories', 500, 'FETCH_FAILED');
      }

      res.status(200).json({
        success: true,
        data: { categories }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to fetch categories', 500, 'FETCH_FAILED');
    }
  });
}

module.exports = new ServiceController();

