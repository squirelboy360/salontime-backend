const { asyncHandler, AppError } = require('../middleware/errorHandler');
const { supabaseAdmin } = require('../config/database');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

class WebhookController {
  /**
   * Handle Stripe webhook events
   */
  handleStripeWebhook = asyncHandler(async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error('❌ STRIPE_WEBHOOK_SECRET not configured');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    let event;

    try {
      // Verify webhook signature
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      console.log(`✅ Webhook verified: ${event.type}`);
    } catch (err) {
      console.error(`❌ Webhook signature verification failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle different event types
    switch (event.type) {
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
        console.log(`⚠️ Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  });

  /**
   * Handle successful checkout session
   */
  async _handleCheckoutSessionCompleted(session) {
    console.log(`💳 Checkout session completed: ${session.id}`);
    console.log(`💳 Payment status: ${session.payment_status}`);
    console.log(`💳 Metadata:`, session.metadata);

    const bookingId = session.metadata?.booking_id;
    const paymentId = session.metadata?.payment_id;

    if (!bookingId) {
      console.error('❌ No booking_id in session metadata');
      return;
    }

    try {
      // Update payment status to completed
      const { error: paymentError } = await supabaseAdmin
        .from('payments')
        .update({
          status: 'completed',
          stripe_payment_intent_id: session.payment_intent,
        })
        .eq('booking_id', bookingId);

      if (paymentError) {
        console.error('❌ Error updating payment:', paymentError);
        return;
      }

      console.log(`✅ Payment updated to completed for booking: ${bookingId}`);

      // Update booking status to confirmed if needed
      const { error: bookingError } = await supabaseAdmin
        .from('bookings')
        .update({
          status: 'confirmed',
        })
        .eq('id', bookingId)
        .eq('status', 'pending'); // Only update if still pending

      if (bookingError) {
        console.error('❌ Error updating booking:', bookingError);
      } else {
        console.log(`✅ Booking confirmed: ${bookingId}`);
      }

    } catch (error) {
      console.error('❌ Error handling checkout session:', error);
    }
  }

  /**
   * Handle successful payment intent
   */
  async _handlePaymentIntentSucceeded(paymentIntent) {
    console.log(`💳 Payment intent succeeded: ${paymentIntent.id}`);
    
    const bookingId = paymentIntent.metadata?.booking_id;
    
    if (!bookingId) {
      console.error('❌ No booking_id in payment intent metadata');
      return;
    }

    try {
      await supabaseAdmin
        .from('payments')
        .update({
          status: 'completed',
        })
        .eq('stripe_payment_intent_id', paymentIntent.id);

      console.log(`✅ Payment updated to completed via payment_intent`);
    } catch (error) {
      console.error('❌ Error handling payment intent:', error);
    }
  }

  /**
   * Handle failed payment intent
   */
  async _handlePaymentIntentFailed(paymentIntent) {
    console.log(`💳 Payment intent failed: ${paymentIntent.id}`);
    
    const bookingId = paymentIntent.metadata?.booking_id;
    
    if (!bookingId) {
      console.error('❌ No booking_id in payment intent metadata');
      return;
    }

    try {
      await supabaseAdmin
        .from('payments')
        .update({
          status: 'failed',
        })
        .eq('stripe_payment_intent_id', paymentIntent.id);

      console.log(`✅ Payment updated to failed`);
    } catch (error) {
      console.error('❌ Error handling failed payment:', error);
    }
  }
}

module.exports = new WebhookController();
