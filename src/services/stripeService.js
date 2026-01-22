const { stripe, isStripeEnabled } = require('../config/stripe');
const { AppError } = require('../middleware/errorHandler');
const config = require('../config');
const { supabaseAdmin } = require('../config/database');

class StripeService {
  constructor() {
    this.stripe = stripe;
    this.isEnabled = isStripeEnabled;
  }

  // Check if Stripe is enabled
  _checkStripeEnabled() {
    if (!this.isEnabled) {
      throw new AppError('Stripe not configured. Add STRIPE_SECRET_KEY to environment.', 503, 'STRIPE_NOT_CONFIGURED');
    }
  }

  // Create Connect account for salon owner
  async createConnectAccount(salonData) {
    this._checkStripeEnabled();

    if (!salonData.country) {
      throw new AppError('Country is required for Stripe account creation', 400, 'MISSING_COUNTRY');
    }

    try {
      const account = await this.stripe.accounts.create({
        type: 'express',
        country: salonData.country,
        business_type: salonData.business_type || 'individual',
        email: salonData.email,
        business_profile: {
          name: salonData.business_name,
          product_description: 'Beauty and salon services',
          mcc: '7230', // Beauty shops
          url: salonData.website || undefined,
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: {
          salon_id: salonData.salon_id,
          owner_id: salonData.owner_id,
        },
      });

      return account;
    } catch (error) {
      console.error('Stripe Connect account creation error:', error);
      if (error.message.includes('responsibilities of managing losses')) {
        throw new AppError(
          'Stripe Connect platform not properly configured. Please complete the platform profile setup at https://dashboard.stripe.com/settings/connect/platform-profile',
          503,
          'STRIPE_CONNECT_NOT_CONFIGURED'
        );
      }
      throw new AppError(`Stripe account creation failed: ${error.message}`, 500, 'STRIPE_ACCOUNT_CREATION_FAILED');
    }
  }

  // Create account link for onboarding
  async createAccountLink(accountId, returnUrl, refreshUrl) {
    this._checkStripeEnabled();
    try {
      const accountLink = await this.stripe.accountLinks.create({
        account: accountId,
        return_url: returnUrl,
        refresh_url: refreshUrl,
        type: 'account_onboarding',
      });
      return accountLink;
    } catch (error) {
      throw new AppError(`Account link creation failed: ${error.message}`, 500, 'STRIPE_LINK_CREATION_FAILED');
    }
  }

  // Get account status
  async getAccountStatus(accountId) {
    this._checkStripeEnabled();
    try {
      const account = await this.stripe.accounts.retrieve(accountId);
      return {
        id: account.id,
        details_submitted: account.details_submitted,
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        requirements: account.requirements,
        capabilities: account.capabilities,
      };
    } catch (error) {
      throw new AppError(`Failed to retrieve account status: ${error.message}`, 500, 'STRIPE_ACCOUNT_RETRIEVAL_FAILED');
    }
  }

  // Handle Stripe webhooks
  async handleWebhook(req, res) {
    const sig = req.headers['stripe-signature'];
    let event;

    const webhookSecrets = [
      process.env.STRIPE_WEBHOOK_SECRET,
      process.env.STRIPE_WEBHOOK_SECRET_THIN,
    ].filter(Boolean);

    if (webhookSecrets.length === 0) {
      console.error('No webhook secrets configured');
      return res.status(400).send('Webhook secret not configured');
    }

    let lastError;
    for (const secret of webhookSecrets) {
      try {
        event = this.stripe.webhooks.constructEvent(req.body, sig, secret);
        break;
      } catch (err) {
        lastError = err;
        continue;
      }
    }

    if (!event) {
      console.error('Webhook signature verification failed:', lastError?.message);
      return res.status(400).send(`Webhook Error: ${lastError?.message || 'Signature verification failed'}`);
    }

    try {
      switch (event.type) {
        case 'account.updated':
        case 'connect.account.updated':
          await this.handleAccountUpdated(event.data.object);
          break;
        case 'checkout.session.completed':
          await this._handleCheckoutSessionCompleted(event.data.object);
          break;
        case 'payment_intent.succeeded':
          await this._handlePaymentIntentSucceeded(event.data.object);
          break;
        case 'payment_intent.payment_failed':
          await this._handlePaymentIntentFailed(event.data.object);
          break;
        default:
          console.log(`Unhandled event type: ${event.type}`);
      }
      res.json({ received: true });
    } catch (error) {
      console.error('Webhook handler error:', error);
      res.status(500).json({ error: 'Webhook handler failed' });
    }
  }

  // Handle Stripe Connect account updates
  async handleAccountUpdated(account) {
    try {
      const isActive = account.charges_enabled && account.payouts_enabled;
      const status = isActive ? 'active' : 'pending';
      const onboardingCompleted = account.details_submitted === true;

      await supabaseAdmin.from('salons').update({
        stripe_account_status: status,
        updated_at: new Date().toISOString()
      }).eq('stripe_account_id', account.id);

      console.log(`🎉 Updated Stripe account ${account.id} status: ${status}`);
    } catch (error) {
      console.error('Error handling account update:', error);
    }
  }

  /**
   * Handle successful checkout session
   */
  async _handleCheckoutSessionCompleted(session) {
    console.log(`💳 Processing checkout session: ${session.id}`);
    const bookingId = session.metadata?.booking_id;
    if (!bookingId) return;

    try {
      let paymentMethod = 'online';
      if (session.payment_intent) {
        const pi = await this.stripe.paymentIntents.retrieve(session.payment_intent);
        if (pi.payment_method) {
          const pm = await this.stripe.paymentMethods.retrieve(pi.payment_method);
          paymentMethod = pm.card?.wallet?.type || pm.type || 'card';
        }
      }

      await supabaseAdmin.from('payments').update({
        status: 'succeeded',
        stripe_payment_intent_id: session.payment_intent,
        payment_method: paymentMethod,
      }).eq('booking_id', bookingId);

      // Only update booking status if it's currently 'pending'
      const { data: currentBooking } = await supabaseAdmin
        .from('bookings')
        .select('status')
        .eq('id', bookingId)
        .single();

      if (currentBooking && currentBooking.status === 'pending') {
        await supabaseAdmin.from('bookings').update({
          status: 'confirmed',
        }).eq('id', bookingId);
        console.log(`📅 Booking ${bookingId} confirmed`);
      } else {
        console.log(`📅 Booking ${bookingId} already in status: ${currentBooking?.status}, skipping confirm`);
      }

      console.log(`✅ Webhook sync complete for booking: ${bookingId}`);
    } catch (error) {
      console.error('❌ Error in checkout session handler:', error);
    }
  }

  async _handlePaymentIntentSucceeded(paymentIntent) {
    console.log(`💳 Processing payment intent: ${paymentIntent.id}`);
    const bookingId = paymentIntent.metadata?.booking_id;
    if (!bookingId) return;

    try {
      await supabaseAdmin.from('payments').update({
        status: 'succeeded',
      }).eq('stripe_payment_intent_id', paymentIntent.id);
      console.log(`✅ Payment updated to succeeded via payment_intent`);
    } catch (error) {
      console.error('❌ Error in payment intent handler:', error);
    }
  }

  async _handlePaymentIntentFailed(paymentIntent) {
    const bookingId = paymentIntent.metadata?.booking_id;
    if (!bookingId) return;
    try {
      await supabaseAdmin.from('payments').update({
        status: 'failed',
      }).eq('stripe_payment_intent_id', paymentIntent.id);
    } catch (error) {
      console.error('❌ Error in payment fail handler:', error);
    }
  }

  // Create checkout session
  async createCheckoutSession(paymentData) {
    this._checkStripeEnabled();
    try {
      return await this.stripe.checkout.sessions.create({
        payment_method_types: ['card', 'ideal'],
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: {
              name: 'Booking Payment',
              description: `Payment for booking ${paymentData.bookingId}`,
            },
            unit_amount: Math.round(paymentData.amount * 100),
          },
          quantity: 1,
        }],
        success_url: `${process.env.FRONTEND_URL || 'https://www.salontime.nl'}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.FRONTEND_URL || 'https://www.salontime.nl'}/payment-cancel`,
        payment_intent_data: {
          application_fee_amount: Math.round(paymentData.amount * 5), // 5% fee
          transfer_data: { destination: paymentData.connectedAccountId },
          metadata: { booking_id: paymentData.bookingId }
        },
        metadata: { booking_id: paymentData.bookingId },
      });
    } catch (error) {
      throw new AppError(`Checkout session creation failed: ${error.message}`, 500, 'STRIPE_CHECKOUT_FAILED');
    }
  }
}

module.exports = new StripeService();
