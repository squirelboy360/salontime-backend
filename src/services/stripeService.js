const { stripe, isStripeEnabled } = require('../config/stripe');
const { AppError } = require('../middleware/errorHandler');
const config = require('../config');

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
      
      // Provide more specific error messages
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

  // Create payment intent with application fee
  async createPaymentIntent(paymentData) {
    this._checkStripeEnabled();

    try {
      const paymentIntent = await this.stripe.paymentIntents.create({
        amount: paymentData.amount,
        currency: paymentData.currency || 'usd',
        customer: paymentData.customer_id,
        payment_method: paymentData.payment_method_id,
        confirmation_method: 'manual',
        confirm: true,
        return_url: process.env.FRONTEND_URL || 'http://localhost:3000',
        // NO APPLICATION FEE - salon owners pay via subscription only
        transfer_data: {
          destination: paymentData.connected_account_id,
        },
        metadata: paymentData.metadata || {},
      });

      return paymentIntent;
    } catch (error) {
      throw new AppError(`Payment intent creation failed: ${error.message}`, 500, 'STRIPE_PAYMENT_INTENT_FAILED');
    }
  }

  // Retrieve payment intent
  async retrievePaymentIntent(paymentIntentId) {
    this._checkStripeEnabled();

    try {
      const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);
      return paymentIntent;
    } catch (error) {
      throw new AppError(`Payment intent retrieval failed: ${error.message}`, 500, 'STRIPE_PAYMENT_RETRIEVAL_FAILED');
    }
  }

  // Create or get customer
  async createOrGetCustomer(userData) {
    this._checkStripeEnabled();

    try {
      // Check if customer already exists
      if (userData.stripe_customer_id) {
        try {
          const customer = await this.stripe.customers.retrieve(userData.stripe_customer_id);
          return customer;
        } catch (error) {
          // Customer not found, create new one
          console.log('Existing customer not found, creating new one');
        }
      }

      // Create new customer
      const customer = await this.stripe.customers.create({
        email: userData.email,
        name: userData.full_name || userData.name,
        metadata: {
          user_id: userData.user_id || userData.id,
          created_from: 'salontime_app'
        }
      });

      // Update user profile with Stripe customer ID
      if (userData.user_id || userData.id) {
        const { supabase } = require('../config/database');
        await supabase
          .from('user_profiles')
          .update({ stripe_customer_id: customer.id })
          .eq('id', userData.user_id || userData.id);
      }

      return customer;
    } catch (error) {
      throw new AppError(`Customer creation failed: ${error.message}`, 500, 'STRIPE_CUSTOMER_CREATION_FAILED');
    }
  }

  // Attach payment method to customer
  async attachPaymentMethod(paymentMethodId, customerId) {
    this._checkStripeEnabled();

    try {
      await this.stripe.paymentMethods.attach(paymentMethodId, {
        customer: customerId,
      });

      return true;
    } catch (error) {
      throw new AppError(`Payment method attachment failed: ${error.message}`, 500, 'STRIPE_PAYMENT_METHOD_ATTACH_FAILED');
    }
  }

  // Detach payment method
  async detachPaymentMethod(paymentMethodId) {
    this._checkStripeEnabled();

    try {
      await this.stripe.paymentMethods.detach(paymentMethodId);
      return true;
    } catch (error) {
      throw new AppError(`Payment method detachment failed: ${error.message}`, 500, 'STRIPE_PAYMENT_METHOD_DETACH_FAILED');
    }
  }

  // Get customer payment methods
  async getCustomerPaymentMethods(customerId) {
    this._checkStripeEnabled();

    try {
      const paymentMethods = await this.stripe.paymentMethods.list({
        customer: customerId,
        type: 'card',
      });

      return paymentMethods.data.map(pm => ({
        id: pm.id,
        brand: pm.card.brand,
        last4: pm.card.last4,
        exp_month: pm.card.exp_month,
        exp_year: pm.card.exp_year
      }));
    } catch (error) {
      throw new AppError(`Payment methods retrieval failed: ${error.message}`, 500, 'STRIPE_PAYMENT_METHODS_FAILED');
    }
  }

  // Create refund
  async createRefund(refundData) {
    this._checkStripeEnabled();

    try {
      const refund = await this.stripe.refunds.create({
        payment_intent: refundData.payment_intent,
        amount: refundData.amount,
        reason: refundData.reason || 'requested_by_customer'
      });

      return refund;
    } catch (error) {
      throw new AppError(`Refund creation failed: ${error.message}`, 500, 'STRIPE_REFUND_FAILED');
    }
  }

  // Handle Stripe webhooks
  async handleWebhook(req, res) {
    const sig = req.headers['stripe-signature'];
    let event;

    console.log('Webhook signature:', sig);
    console.log('Body type:', typeof req.body);
    console.log('Body length:', req.body ? req.body.length : 'No body');

    // Try both webhook secrets (snapshot and thin payloads)
    const webhookSecrets = [
      process.env.STRIPE_WEBHOOK_SECRET, // Snapshot payload secret
      process.env.STRIPE_WEBHOOK_SECRET_THIN, // Thin payload secret (for v2 events)
    ].filter(Boolean); // Remove undefined values

    if (webhookSecrets.length === 0) {
      console.error('No webhook secrets configured');
      return res.status(400).send('Webhook secret not configured');
    }

    let lastError;
    for (const secret of webhookSecrets) {
      try {
        event = this.stripe.webhooks.constructEvent(req.body, sig, secret);
        console.log('Webhook event type:', event.type, 'verified with secret');
        break; // Successfully verified
      } catch (err) {
        lastError = err;
        continue; // Try next secret
      }
    }

    if (!event) {
      console.error('Webhook signature verification failed with all secrets:', lastError?.message);
      return res.status(400).send(`Webhook Error: ${lastError?.message || 'Signature verification failed'}`);
    }

    try {
      switch (event.type) {
        case 'account.updated':
        case 'connect.account.updated':
        case 'v2.core.account.updated': // Stripe Connect v2 event (thin payload)
          // v2 events have different structure - extract account from nested structure
          const account = event.type.startsWith('v2.') 
            ? event.data.object 
            : event.data.object;
          await this.handleAccountUpdated(account);
          break;
        case 'payment_intent.succeeded':
          await this.handlePaymentSucceeded(event.data.object);
          break;
        case 'payment_intent.payment_failed':
          await this.handlePaymentFailed(event.data.object);
          break;
        case 'customer.subscription.created':
          await this.handleSubscriptionCreated(event.data.object);
          break;
        case 'customer.subscription.updated':
          await this.handleSubscriptionUpdated(event.data.object);
          break;
        case 'customer.subscription.deleted':
          await this.handleSubscriptionDeleted(event.data.object);
          break;
        case 'invoice.payment_succeeded':
          await this.handleInvoicePaymentSucceeded(event.data.object);
          break;
        case 'invoice.payment_failed':
          await this.handleInvoicePaymentFailed(event.data.object);
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
    const { supabaseAdmin } = require('../config/database');
    
    try {
      console.log('Processing account update for:', account.id);
      console.log('Account details:', {
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        details_submitted: account.details_submitted,
        requirements: account.requirements
      });

      const isActive = account.charges_enabled && account.payouts_enabled;
      const status = isActive ? 'active' : 'pending';

      // Update stripe_accounts table
      const { error: accountsError } = await supabaseAdmin
        .from('stripe_accounts')
        .update({
          account_status: status,
          charges_enabled: account.charges_enabled,
          payouts_enabled: account.payouts_enabled,
          details_submitted: account.details_submitted,
          capabilities: account.capabilities,
          requirements: account.requirements,
          updated_at: new Date().toISOString()
        })
        .eq('stripe_account_id', account.id);

      if (accountsError) {
        console.error('Failed to update Stripe account status:', accountsError);
      } else {
        console.log('✅ Updated stripe_accounts table');
      }

      // Also update salons table
      const { error: salonsError } = await supabaseAdmin
        .from('salons')
        .update({
          stripe_account_status: status,
          updated_at: new Date().toISOString()
        })
        .eq('stripe_account_id', account.id);

      if (salonsError) {
        console.error('Failed to update salon Stripe status:', salonsError);
      } else {
        console.log('✅ Updated salons table');
      }

      console.log(`🎉 Updated Stripe account ${account.id} status: ${status}`);
    } catch (error) {
      console.error('Error handling account update webhook:', error);
    }
  }

  // Handle successful payments
  async handlePaymentSucceeded(paymentIntent) {
    const { supabase } = require('../config/database');
    
    try {
      // Find payment record to get booking_id
      const { data: payment } = await supabase
        .from('payments')
        .select('booking_id')
        .eq('stripe_payment_intent_id', paymentIntent.id)
        .single();

      const { error } = await supabase
        .from('payments')
        .update({
          status: 'completed',
          stripe_charge_id: paymentIntent.latest_charge,
          processed_at: new Date().toISOString()
        })
        .eq('stripe_payment_intent_id', paymentIntent.id);

      if (error) {
        console.error('Failed to update payment status:', error);
      } else if (payment && payment.booking_id) {
        // Also update booking payment_status
        const { error: bookingError } = await supabase
          .from('bookings')
          .update({
            payment_status: 'paid',
            updated_at: new Date().toISOString()
          })
          .eq('id', payment.booking_id);
        
        if (bookingError) {
          console.error('Failed to update booking payment status:', bookingError);
        }
      }
    } catch (error) {
      console.error('Error handling payment success webhook:', error);
    }
  }

  // Handle failed payments
  async handlePaymentFailed(paymentIntent) {
    const { supabase } = require('../config/database');
    
    try {
      // Find payment record to get booking_id
      const { data: payment } = await supabase
        .from('payments')
        .select('booking_id')
        .eq('stripe_payment_intent_id', paymentIntent.id)
        .single();

      const { error } = await supabase
        .from('payments')
        .update({
          status: 'failed',
          failure_reason: paymentIntent.last_payment_error?.message || 'Payment failed'
        })
        .eq('stripe_payment_intent_id', paymentIntent.id);

      if (error) {
        console.error('Failed to update payment status:', error);
      } else if (payment && payment.booking_id) {
        // Also update booking payment_status
        const { error: bookingError } = await supabase
          .from('bookings')
          .update({
            payment_status: 'pending', // Reset to pending on failure
            updated_at: new Date().toISOString()
          })
          .eq('id', payment.booking_id);
        
        if (bookingError) {
          console.error('Failed to update booking payment status:', bookingError);
        }
      }
    } catch (error) {
      console.error('Error handling payment failure webhook:', error);
    }
  }

  // Handle subscription created
  async handleSubscriptionCreated(subscription) {
    const { supabase } = require('../config/database');
    
    try {
      // Update salon subscription status
      const { error } = await supabase
        .from('salons')
        .update({
          subscription_plan: 'plus',
          subscription_status: subscription.status,
          stripe_subscription_id: subscription.id,
          trial_ends_at: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
          subscription_ends_at: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null
        })
        .eq('stripe_customer_id', subscription.customer);

      if (error) {
        console.error('Failed to update subscription status:', error);
      }
    } catch (error) {
      console.error('Error handling subscription created webhook:', error);
    }
  }

  // Handle subscription updated
  async handleSubscriptionUpdated(subscription) {
    const { supabase } = require('../config/database');
    
    try {
      const { error } = await supabase
        .from('salons')
        .update({
          subscription_status: subscription.status,
          subscription_ends_at: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
          trial_ends_at: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null
        })
        .eq('stripe_subscription_id', subscription.id);

      if (error) {
        console.error('Failed to update subscription status:', error);
      }
    } catch (error) {
      console.error('Error handling subscription updated webhook:', error);
    }
  }

  // Handle subscription deleted/cancelled
  async handleSubscriptionDeleted(subscription) {
    const { supabase } = require('../config/database');
    
    try {
      const { error } = await supabase
        .from('salons')
        .update({
          subscription_plan: 'basic',
          subscription_status: 'cancelled',
          subscription_ends_at: new Date().toISOString()
        })
        .eq('stripe_subscription_id', subscription.id);

      if (error) {
        console.error('Failed to update subscription cancellation:', error);
      }
    } catch (error) {
      console.error('Error handling subscription deleted webhook:', error);
    }
  }

  // Handle successful invoice payment
  async handleInvoicePaymentSucceeded(invoice) {
    const { supabase } = require('../config/database');
    
    try {
      if (invoice.subscription) {
        const { error } = await supabase
          .from('salons')
          .update({
            subscription_status: 'active',
            last_payment_date: new Date().toISOString()
          })
          .eq('stripe_subscription_id', invoice.subscription);

        if (error) {
          console.error('Failed to update subscription payment:', error);
        }
      }
    } catch (error) {
      console.error('Error handling invoice payment success webhook:', error);
    }
  }

  // Handle failed invoice payment
  async handleInvoicePaymentFailed(invoice) {
    const { supabase } = require('../config/database');
    
    try {
      if (invoice.subscription) {
        const { error } = await supabase
          .from('salons')
          .update({
            subscription_status: 'past_due'
          })
          .eq('stripe_subscription_id', invoice.subscription);

        if (error) {
          console.error('Failed to update subscription payment failure:', error);
        }
      }
    } catch (error) {
      console.error('Error handling invoice payment failure webhook:', error);
    }
  }

  // Get account dashboard link
  async createDashboardLink(accountId) {
    this._checkStripeEnabled();

    try {
      const link = await this.stripe.accounts.createLoginLink(accountId);
      return link;
    } catch (error) {
      throw new AppError(`Dashboard link creation failed: ${error.message}`, 500, 'STRIPE_DASHBOARD_LINK_FAILED');
    }
  }

  // ==================== SUBSCRIPTION MANAGEMENT ====================

  // Create subscription for salon owner premium plan
  async createSubscription(customerId, priceId, trialDays = config.subscription.trial_days) {
    this._checkStripeEnabled();

    try {
      const subscription = await this.stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
        trial_period_days: trialDays,
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        expand: ['latest_invoice.payment_intent'],
      });

      return subscription;
    } catch (error) {
      throw new AppError(`Subscription creation failed: ${error.message}`, 500, 'STRIPE_SUBSCRIPTION_FAILED');
    }
  }

  // Cancel subscription
  async cancelSubscription(subscriptionId, cancelAtPeriodEnd = true) {
    this._checkStripeEnabled();

    try {
      const subscription = await this.stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: cancelAtPeriodEnd,
      });

      if (!cancelAtPeriodEnd) {
        await this.stripe.subscriptions.cancel(subscriptionId);
      }

      return subscription;
    } catch (error) {
      throw new AppError(`Subscription cancellation failed: ${error.message}`, 500, 'STRIPE_SUBSCRIPTION_CANCEL_FAILED');
    }
  }

  // Get subscription status
  async getSubscription(subscriptionId) {
    this._checkStripeEnabled();

    try {
      const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
      return subscription;
    } catch (error) {
      throw new AppError(`Subscription retrieval failed: ${error.message}`, 500, 'STRIPE_SUBSCRIPTION_RETRIEVAL_FAILED');
    }
  }

  // Update subscription
  async updateSubscription(subscriptionId, updates) {
    this._checkStripeEnabled();

    try {
      const subscription = await this.stripe.subscriptions.update(subscriptionId, updates);
      return subscription;
    } catch (error) {
      throw new AppError(`Subscription update failed: ${error.message}`, 500, 'STRIPE_SUBSCRIPTION_UPDATE_FAILED');
    }
  }

  // Create billing portal session
  async createBillingPortalSession(customerId, returnUrl) {
    this._checkStripeEnabled();

    try {
      const session = await this.stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });

      return session;
    } catch (error) {
      throw new AppError(`Billing portal creation failed: ${error.message}`, 500, 'STRIPE_BILLING_PORTAL_FAILED');
    }
  }

  // Create checkout session for salon's connected account (payment link)
  // Creates session on platform, transfers payment to connected account
  async createCheckoutSession(paymentData) {
    this._checkStripeEnabled();

    try {
      // Create checkout session on platform account, with transfer to connected account
      const session = await this.stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: paymentData.currency || 'eur',
            product_data: {
              name: paymentData.productName || 'Booking Payment',
              description: paymentData.description || `Payment for booking ${paymentData.bookingId}`,
            },
            unit_amount: Math.round(paymentData.amount * 100), // Convert to cents
          },
          quantity: 1,
        }],
        success_url: paymentData.successUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: paymentData.cancelUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-cancel`,
        payment_intent_data: {
          application_fee_amount: 0, // No platform fee
          transfer_data: {
            destination: paymentData.connectedAccountId, // Salon's connected account
          },
          on_behalf_of: paymentData.connectedAccountId,
        },
        metadata: paymentData.metadata || {},
      });

      return session;
    } catch (error) {
      throw new AppError(`Checkout session creation failed: ${error.message}`, 500, 'STRIPE_CHECKOUT_FAILED');
    }
  }

  // Construct webhook event for verification (used by payment controller)
  constructWebhookEvent(payload, signature, endpointSecret) {
    this._checkStripeEnabled();

    try {
      return this.stripe.webhooks.constructEvent(payload, signature, endpointSecret);
    } catch (error) {
      throw new AppError(`Webhook signature verification failed: ${error.message}`, 400, 'WEBHOOK_VERIFICATION_FAILED');
    }
  }
}

module.exports = new StripeService();

