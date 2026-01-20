const stripeService = require('../services/stripeService');
const { supabase } = require('../config/database');
const config = require('../config');
const { asyncHandler, AppError } = require('../middleware/errorHandler');

class PaymentController {
  // Handle Stripe webhooks (no auth required - uses webhook signature verification)
  async handleWebhook(req, res) {
    try {
      const sig = req.headers['stripe-signature'];
      const endpointSecret = config.stripe.webhook_secret;
      
      if (!endpointSecret) {
        console.error('Webhook secret not configured');
        return res.status(400).send('Webhook secret not configured');
      }

      // Verify webhook signature
      const event = stripeService.constructWebhookEvent(req.body, sig, endpointSecret);
      
      console.log('Received webhook event:', event.type);

      switch (event.type) {
        case 'payment_intent.succeeded':
          await this.handlePaymentSuccess(event.data.object);
          break;
        case 'payment_intent.payment_failed':
          await this.handlePaymentFailure(event.data.object);
          break;
        case 'checkout.session.completed':
          await this.handleCheckoutSessionCompleted(event.data.object);
          break;
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
          await this.handleSubscriptionChange(event.data.object);
          break;
        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      res.json({ received: true });
    } catch (error) {
      console.error('Webhook error:', error);
      res.status(400).send(`Webhook Error: ${error.message}`);
    }
  }

  // Create payment intent for service booking
  async createPaymentIntent(req, res) {
    try {
      const { amount, currency = 'usd', serviceId, salonId } = req.body;
      const userId = req.user.id;

      if (!amount || !serviceId || !salonId) {
        return res.status(400).json({ 
          error: 'Missing required fields: amount, serviceId, salonId' 
        });
      }

      // Get salon's Stripe account
      const { data: salon } = await supabase
        .from('salons')
        .select('stripe_account_id, name')
        .eq('id', salonId)
        .single();

      if (!salon || !salon.stripe_account_id) {
        return res.status(404).json({ 
          error: 'Salon not found or Stripe not configured' 
        });
      }

      // Create payment intent - NO APPLICATION FEE (commission removed)
      const paymentIntent = await stripeService.createPaymentIntent({
        amount: Math.round(amount * 100), // Convert to cents
        currency,
        transfer_data: {
          destination: salon.stripe_account_id,
        },
        metadata: {
          userId,
          serviceId,
          salonId,
          salonName: salon.name
        }
      });

      // Store payment intent metadata for later linking when booking is created
      // We'll link this to the payment record via webhook or when booking is created
      // The booking creation will look for this payment intent and link it

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        metadata: {
          userId,
          serviceId,
          salonId
        }
      });
    } catch (error) {
      console.error('Payment intent creation error:', error);
      res.status(500).json({ error: 'Failed to create payment intent' });
    }
  }

  // Confirm payment completion
  async confirmPayment(req, res) {
    try {
      const { paymentIntentId } = req.params;
      const userId = req.user.id;

      // Retrieve payment intent from Stripe
      const paymentIntent = await stripeService.retrievePaymentIntent(paymentIntentId);

      if (!paymentIntent) {
        return res.status(404).json({ error: 'Payment intent not found' });
      }

      // Update payment status in database
      const { error } = await supabase
        .from('payments')
        .update({ 
          status: paymentIntent.status,
          updated_at: new Date().toISOString()
        })
        .eq('stripe_payment_intent_id', paymentIntentId)
        .eq('user_id', userId);

      if (error) {
        console.error('Failed to update payment status:', error);
      }

      res.json({
        status: paymentIntent.status,
        paymentIntent: {
          id: paymentIntent.id,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          status: paymentIntent.status
        }
      });
    } catch (error) {
      console.error('Payment confirmation error:', error);
      res.status(500).json({ error: 'Failed to confirm payment' });
    }
  }

  // Get user's payment history
  async getPaymentHistory(req, res) {
    try {
      const userId = req.user.id;
      const { page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      // Query payments via bookings (payments table doesn't have user_id)
      const { data: payments, error } = await supabase
        .from('payments')
        .select(`
          *,
          bookings!inner(client_id, salon_id, service_id),
          salons(name, address, business_name),
          services(name, duration, price)
        `)
        .eq('bookings.client_id', userId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        throw error;
      }

      // Flatten the response for easier frontend consumption
      const flattenedPayments = (payments || []).map(payment => ({
        id: payment.id,
        booking_id: payment.booking_id,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        payment_method: payment.payment_method,
        stripe_payment_intent_id: payment.stripe_payment_intent_id,
        created_at: payment.created_at,
        updated_at: payment.updated_at,
        salon: payment.salons ? {
          name: payment.salons.business_name || payment.salons.name,
          address: payment.salons.address
        } : null,
        service: payment.services ? {
          name: payment.services.name,
          duration: payment.services.duration,
          price: payment.services.price
        } : null
      }));

      res.json({
        payments: flattenedPayments,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          hasMore: payments?.length === parseInt(limit)
        }
      });
    } catch (error) {
      console.error('Payment history error:', error);
      res.status(500).json({ error: 'Failed to retrieve payment history' });
    }
  }

  // Get salon's payment data (salon owner only)
  async getSalonPayments(req, res) {
    try {
      const userId = req.user.id;
      const { page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      // Verify user owns a salon
      const { data: salon } = await supabase
        .from('salons')
        .select('id')
        .eq('owner_id', userId)
        .single();

      if (!salon) {
        return res.status(403).json({ error: 'Access denied: Not a salon owner' });
      }

      const { data: payments, error } = await supabase
        .from('payments')
        .select(`
          *,
          users(email, full_name),
          services(name, duration)
        `)
        .eq('salon_id', salon.id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        throw error;
      }

      res.json({
        payments: payments || [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          hasMore: payments?.length === parseInt(limit)
        }
      });
    } catch (error) {
      console.error('Salon payments error:', error);
      res.status(500).json({ error: 'Failed to retrieve salon payments' });
    }
  }

  // Get payment analytics (salon owner only)
  async getPaymentAnalytics(req, res) {
    try {
      const userId = req.user.id;
      const { period, start_date, end_date } = req.query;

      // Verify user owns a salon
      const { data: salon } = await supabase
        .from('salons')
        .select('id, business_name')
        .eq('owner_id', userId)
        .single();

      if (!salon) {
        return res.status(403).json({ error: 'Access denied: Not a salon owner' });
      }

      // Calculate date range
      let startDate, endDate;
      const now = new Date();

      if (start_date && end_date) {
        startDate = new Date(start_date);
        endDate = new Date(end_date);
      } else if (period) {
        const days = parseInt(period);
        if (isNaN(days) || days <= 0) {
          return res.status(400).json({ error: 'Invalid period parameter' });
        }
        endDate = new Date(now);
        startDate = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
      } else {
        // Default to last 30 days
        endDate = new Date(now);
        startDate = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
      }

      // Format dates for Supabase query
      const startDateStr = startDate.toISOString().split('T')[0];
      const endDateStr = endDate.toISOString().split('T')[0];

      // Get all successful payments within date range
      const { data: payments, error } = await supabase
        .from('payments')
        .select(`
          amount,
          currency,
          created_at,
          services(name, category),
          bookings(appointment_date)
        `)
        .eq('salon_id', salon.id)
        .eq('status', 'succeeded')
        .gte('created_at', startDateStr)
        .lte('created_at', endDateStr)
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      // Calculate comprehensive analytics
      const totalRevenue = payments.reduce((sum, payment) => sum + payment.amount, 0);
      const totalTransactions = payments.length;
      const averageTransaction = totalTransactions > 0 ? totalRevenue / totalTransactions : 0;

      // Revenue by service category
      const revenueByCategory = payments.reduce((acc, payment) => {
        const category = payment.services?.category || 'Other';
        acc[category] = (acc[category] || 0) + payment.amount;
        return acc;
      }, {});

      // Daily revenue trend
      const dailyRevenue = payments.reduce((acc, payment) => {
        const date = payment.created_at.split('T')[0];
        acc[date] = (acc[date] || 0) + payment.amount;
        return acc;
      }, {});

      // Monthly revenue trend (for longer periods)
      const monthlyRevenue = payments.reduce((acc, payment) => {
        const date = new Date(payment.created_at);
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        acc[monthKey] = (acc[monthKey] || 0) + payment.amount;
        return acc;
      }, {});

      // Top performing services
      const serviceRevenue = payments.reduce((acc, payment) => {
        const serviceName = payment.services?.name || 'Unknown Service';
        if (!acc[serviceName]) {
          acc[serviceName] = { revenue: 0, count: 0 };
        }
        acc[serviceName].revenue += payment.amount;
        acc[serviceName].count += 1;
        return acc;
      }, {});

      const topServices = Object.entries(serviceRevenue)
        .map(([name, data]) => ({
          name,
          revenue: data.revenue,
          transactionCount: data.count,
          averageValue: data.revenue / data.count
        }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);

      // Calculate growth metrics
      const previousPeriodStart = new Date(startDate.getTime() - (endDate.getTime() - startDate.getTime()));
      const previousPeriodEnd = new Date(startDate);

      const { data: previousPayments } = await supabase
        .from('payments')
        .select('amount')
        .eq('salon_id', salon.id)
        .eq('status', 'succeeded')
        .gte('created_at', previousPeriodStart.toISOString().split('T')[0])
        .lt('created_at', previousPeriodEnd.toISOString().split('T')[0]);

      const previousRevenue = previousPayments?.reduce((sum, payment) => sum + payment.amount, 0) || 0;
      const revenueGrowth = previousRevenue > 0 ? ((totalRevenue - previousRevenue) / previousRevenue) * 100 : 0;

      res.json({
        success: true,
        data: {
          salon: {
            id: salon.id,
            name: salon.business_name
          },
          period: {
            start_date: startDateStr,
            end_date: endDateStr,
            days: Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24))
          },
          summary: {
            totalRevenue,
            totalTransactions,
            averageTransaction,
            currency: payments[0]?.currency || 'usd'
          },
          growth: {
            previousPeriodRevenue: previousRevenue,
            revenueGrowth: Math.round(revenueGrowth * 100) / 100 // Round to 2 decimal places
          },
          trends: {
            daily: dailyRevenue,
            monthly: monthlyRevenue
          },
          breakdown: {
            byCategory: revenueByCategory,
            topServices
          }
        }
      });
    } catch (error) {
      console.error('Payment analytics error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve payment analytics',
        code: 'ANALYTICS_ERROR'
      });
    }
  }

  // Process subscription payment
  async processSubscription(req, res) {
    try {
      const { planId, salonId } = req.body;
      const userId = req.user.id;

      if (!planId || !salonId) {
        return res.status(400).json({ 
          error: 'Missing required fields: planId, salonId' 
        });
      }

      // Verify user owns the salon
      const { data: salon } = await supabase
        .from('salons')
        .select('id, stripe_customer_id')
        .eq('id', salonId)
        .eq('owner_id', userId)
        .single();

      if (!salon) {
        return res.status(403).json({ error: 'Access denied: Salon not found or not owned by user' });
      }

      // Get subscription plan details
      const plan = config.subscription.plans[planId];
      if (!plan) {
        return res.status(400).json({ error: 'Invalid subscription plan' });
      }

      // Create subscription
      const subscription = await stripeService.createSubscription({
        customer: salon.stripe_customer_id,
        price: plan.stripePriceId,
        metadata: {
          salonId: salon.id,
          userId: userId,
          planId: planId
        }
      });

      res.json({
        subscriptionId: subscription.id,
        clientSecret: subscription.latest_invoice.payment_intent.client_secret,
        status: subscription.status
      });
    } catch (error) {
      console.error('Subscription processing error:', error);
      res.status(500).json({ error: 'Failed to process subscription' });
    }
  }

  // Handle successful payment webhook
  async handlePaymentSuccess(paymentIntent) {
    try {
      // Extract metadata to find the booking if payment record doesn't exist yet
      const metadata = paymentIntent.metadata || {};
      const { userId, serviceId, salonId } = metadata;

      // Try to find existing payment record
      let { data: existingPayment } = await supabase
        .from('payments')
        .select('*')
        .eq('stripe_payment_intent_id', paymentIntent.id)
        .single();

      // If no payment record exists, try to find booking and create payment record
      if (!existingPayment && userId && serviceId && salonId) {
        // Find the most recent booking for this user/service/salon that doesn't have a payment yet
        const { data: booking } = await supabase
          .from('bookings')
          .select('id')
          .eq('client_id', userId)
          .eq('salon_id', salonId)
          .eq('service_id', serviceId)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (booking) {
          // Check if payment record already exists for this booking
          const { data: bookingPayment } = await supabase
            .from('payments')
            .select('*')
            .eq('booking_id', booking.id)
            .single();

          if (!bookingPayment) {
            // Create payment record linked to booking
            const { data: newPayment } = await supabase
              .from('payments')
              .insert([{
                booking_id: booking.id,
                stripe_payment_intent_id: paymentIntent.id,
                amount: paymentIntent.amount / 100, // Convert from cents
                currency: paymentIntent.currency.toUpperCase(),
                status: 'completed'
              }])
              .select()
              .single();

            existingPayment = newPayment;
            console.log(`✅ Created and linked payment record for booking ${booking.id}`);
          } else {
            // Update existing payment record with payment intent ID
            const { data: updatedPayment } = await supabase
              .from('payments')
              .update({
                stripe_payment_intent_id: paymentIntent.id,
                status: 'completed',
                updated_at: new Date().toISOString()
              })
              .eq('booking_id', booking.id)
              .select()
              .single();

            existingPayment = updatedPayment;
            console.log(`✅ Linked payment intent to existing payment record for booking ${booking.id}`);
          }
        }
      }

      // Update payment status if record exists
      if (existingPayment) {
        const { error } = await supabase
        .from('payments')
        .update({ 
            status: 'completed',
          updated_at: new Date().toISOString()
        })
          .eq('id', existingPayment.id);

      if (error) {
        console.error('Failed to update payment status:', error);
        } else {
          console.log(`✅ Payment succeeded and updated: ${paymentIntent.id}`);
          
          // Also update booking payment_status if payment is linked to a booking
          if (existingPayment.booking_id) {
            const { error: bookingError } = await supabase
              .from('bookings')
              .update({
                payment_status: 'paid',
                updated_at: new Date().toISOString()
              })
              .eq('id', existingPayment.booking_id);
            
            if (bookingError) {
              console.error('Failed to update booking payment status:', bookingError);
            } else {
              console.log(`✅ Updated booking ${existingPayment.booking_id} payment_status to 'paid'`);
            }
          }
        }
      } else {
        console.warn(`⚠️ Payment succeeded but no booking found to link: ${paymentIntent.id}`);
      }
    } catch (error) {
      console.error('Error handling payment success:', error);
    }
  }

  // Handle failed payment webhook
  async handlePaymentFailure(paymentIntent) {
    try {
      // Find payment record
      const { data: payment } = await supabase
        .from('payments')
        .select('booking_id')
        .eq('stripe_payment_intent_id', paymentIntent.id)
        .single();

      // Update payment status
      const { error } = await supabase
        .from('payments')
        .update({ 
          status: 'failed',
          updated_at: new Date().toISOString()
        })
        .eq('stripe_payment_intent_id', paymentIntent.id);

      if (error) {
        console.error('Failed to update payment status:', error);
      }

      // Also update booking payment_status if payment is linked to a booking
      if (payment && payment.booking_id) {
        const { error: bookingError } = await supabase
          .from('bookings')
          .update({
            payment_status: 'pending', // Reset to pending on failure
            updated_at: new Date().toISOString()
          })
          .eq('id', payment.booking_id);
        
        if (bookingError) {
          console.error('Failed to update booking payment status:', bookingError);
        } else {
          console.log(`✅ Updated booking ${payment.booking_id} payment_status to 'pending'`);
        }
      }

      console.log(`Payment failed: ${paymentIntent.id}`);
    } catch (error) {
      console.error('Error handling payment failure:', error);
    }
  }

  // Update payment status manually (for cash/physical payments - salon owner only)
  updatePaymentStatus = asyncHandler(async (req, res) => {
    const { bookingId } = req.params;
    const { status, payment_method } = req.body;
    const userId = req.user.id;

    const validStatuses = ['pending', 'completed', 'failed', 'refunded'];
    if (!validStatuses.includes(status)) {
      throw new AppError('Invalid payment status', 400, 'INVALID_PAYMENT_STATUS');
    }

    // Verify user owns the salon for this booking
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select(`
        *,
        salons(owner_id, id)
      `)
      .eq('id', bookingId)
      .single();

    if (bookingError || !booking) {
      throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
    }

    if (booking.salons.owner_id !== userId) {
      throw new AppError('Access denied: Not the salon owner', 403, 'ACCESS_DENIED');
    }

    // Update payment status
    const updateData = {
      status,
      updated_at: new Date().toISOString()
    };

    if (payment_method) {
      updateData.payment_method = payment_method;
    }

    const { data: updatedPayment, error: updateError } = await supabase
      .from('payments')
      .update(updateData)
      .eq('booking_id', bookingId)
      .select()
      .single();

    if (updateError) {
      throw new AppError('Failed to update payment status', 500, 'PAYMENT_UPDATE_FAILED');
    }

    res.json({
      success: true,
      data: { payment: updatedPayment }
    });
  });

  // Generate payment link for booking (salon owner generates link for client to pay)
  generatePaymentLink = asyncHandler(async (req, res) => {
    const { bookingId } = req.params;
    const userId = req.user.id;

    // Get booking with salon info
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select(`
        *,
        salons(owner_id, stripe_account_id, business_name),
        services(name, price),
        user_profiles!client_id(email, first_name, last_name)
      `)
      .eq('id', bookingId)
      .single();

    if (bookingError || !booking) {
      throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
    }

    // Verify user owns the salon
    if (booking.salons.owner_id !== userId) {
      throw new AppError('Access denied: Not the salon owner', 403, 'ACCESS_DENIED');
    }

    // Check if salon has Stripe account
    if (!booking.salons.stripe_account_id) {
      throw new AppError('Salon Stripe account not configured. Please complete Stripe onboarding first.', 400, 'STRIPE_NOT_CONFIGURED');
    }

    // Get or create payment record
    let { data: payment } = await supabase
      .from('payments')
      .select('*')
      .eq('booking_id', bookingId)
      .single();

    if (!payment) {
      // Create payment record if it doesn't exist
      const { data: newPayment, error: paymentCreateError } = await supabase
        .from('payments')
        .insert([{
          booking_id: bookingId,
          amount: booking.services.price,
          currency: 'EUR',
          status: 'pending'
        }])
        .select()
        .single();
      
      if (paymentCreateError) {
        throw new AppError('Failed to create payment record', 500, 'PAYMENT_CREATE_FAILED');
      }
      payment = newPayment;
    }

    // Generate checkout session (payment link)
    const checkoutSession = await stripeService.createCheckoutSession({
      bookingId: bookingId,
      amount: payment.amount,
      currency: payment.currency || 'eur',
      connectedAccountId: booking.salons.stripe_account_id,
      productName: `${booking.services.name} - ${booking.salons.business_name}`,
      description: `Payment for booking on ${booking.appointment_date} at ${booking.start_time}`,
      successUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-success?session_id={CHECKOUT_SESSION_ID}&booking_id=${bookingId}`,
      cancelUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-cancel?booking_id=${bookingId}`,
      metadata: {
        booking_id: bookingId,
        client_id: booking.client_id,
        salon_id: booking.salon_id,
        service_id: booking.service_id
      }
    });

    // Update payment record with checkout session ID
    const { error: updateError } = await supabase
      .from('payments')
      .update({
        stripe_checkout_session_id: checkoutSession.id,
        updated_at: new Date().toISOString()
      })
      .eq('booking_id', bookingId);

    if (updateError) {
      console.warn('Failed to update payment with checkout session ID:', updateError);
    }

    res.json({
      success: true,
      data: {
        paymentLink: checkoutSession.url,
        checkoutSessionId: checkoutSession.id,
        expiresAt: checkoutSession.expires_at
      }
    });
  });

  // Handle checkout session completed webhook
  async handleCheckoutSessionCompleted(session) {
    try {
      const { booking_id } = session.metadata || {};
      
      if (!booking_id) {
        console.warn('⚠️ Checkout session completed but no booking_id in metadata:', session.id);
        return;
      }

      // Update payment record
      const { error: updateError } = await supabase
        .from('payments')
        .update({
          status: 'completed',
          stripe_checkout_session_id: session.id,
          stripe_payment_intent_id: session.payment_intent,
          payment_method: 'card',
          updated_at: new Date().toISOString()
        })
        .eq('booking_id', booking_id);

      if (updateError) {
        console.error('Failed to update payment from checkout session:', updateError);
      } else {
        console.log(`✅ Payment completed via checkout session for booking ${booking_id}`);
      }
    } catch (error) {
      console.error('Error handling checkout session completed:', error);
    }
  }

  // Handle subscription changes webhook
  async handleSubscriptionChange(subscription) {
    try {
      const salonId = subscription.metadata.salonId;
      
      if (!salonId) {
        console.error('No salon ID in subscription metadata');
        return;
      }

      const { error } = await supabase
        .from('salon_subscriptions')
        .upsert({
          salon_id: salonId,
          stripe_subscription_id: subscription.id,
          status: subscription.status,
          current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          updated_at: new Date().toISOString()
        });

      if (error) {
        console.error('Failed to update subscription status:', error);
      }

      console.log(`Subscription updated: ${subscription.id}`);
    } catch (error) {
      console.error('Error handling subscription change:', error);
    }
  }
}

module.exports = new PaymentController();

