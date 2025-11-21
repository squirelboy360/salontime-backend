const { transporter, isEmailEnabled, fromEmail } = require('../config/email');
const { AppError } = require('../middleware/errorHandler');

class EmailService {
  constructor() {
    this.transporter = transporter;
    this.isEnabled = isEmailEnabled;
    this.fromEmail = fromEmail;
  }

  // Check if email is enabled
  _checkEmailEnabled() {
    if (!this.isEnabled) {
      console.warn('Email not configured - email will be skipped');
      return false;
    }
    return true;
  }

  // Send booking confirmation email
  async sendBookingConfirmation(booking, client, salon) {
    if (!this._checkEmailEnabled()) return null;

    try {
      const mailOptions = {
        from: this.fromEmail,
        to: client.email,
        subject: 'Booking Confirmation - SalonTime',
        html: this._generateBookingConfirmationTemplate(booking, client, salon),
      };

      const result = await this.transporter.sendMail(mailOptions);
      return result;
    } catch (error) {
      console.error('Failed to send booking confirmation email:', error);
      // Don't throw error to avoid breaking the booking flow
      return null;
    }
  }

  // Send booking reminder email
  async sendBookingReminder(booking, client, salon) {
    if (!this._checkEmailEnabled()) return null;

    try {
      const mailOptions = {
        from: this.fromEmail,
        to: client.email,
        subject: 'Appointment Reminder - SalonTime',
        html: this._generateBookingReminderTemplate(booking, client, salon),
      };

      const result = await this.transporter.sendMail(mailOptions);
      return result;
    } catch (error) {
      console.error('Failed to send booking reminder email:', error);
      return null;
    }
  }

  // Send booking reschedule notice
  async sendBookingRescheduleNotice(booking, client, salon, oldDate, oldTime) {
    if (!this._checkEmailEnabled()) return null;

    try {
      const mailOptions = {
        from: this.fromEmail,
        to: client.email,
        subject: 'Appointment Rescheduled - SalonTime',
        html: this._generateBookingRescheduleTemplate(booking, client, salon, oldDate, oldTime),
      };

      const result = await this.transporter.sendMail(mailOptions);
      
      // Also notify salon owner
      if (salon.email) {
        const salonMailOptions = {
          from: this.fromEmail,
          to: salon.email,
          subject: `Booking Rescheduled - ${client.first_name} ${client.last_name}`,
          html: this._generateSalonRescheduleNoticeTemplate(booking, client, salon, oldDate, oldTime),
        };
        await this.transporter.sendMail(salonMailOptions);
      }
      
      return result;
    } catch (error) {
      console.error('Failed to send reschedule email:', error);
      return null;
    }
  }

  // Send cancellation notice
  async sendCancellationNotice(booking, client, salon, reason = '') {
    if (!this._checkEmailEnabled()) return null;

    try {
      const mailOptions = {
        from: this.fromEmail,
        to: client.email,
        subject: 'Appointment Cancelled - SalonTime',
        html: this._generateCancellationTemplate(booking, client, salon, reason),
      };

      const result = await this.transporter.sendMail(mailOptions);
      return result;
    } catch (error) {
      console.error('Failed to send cancellation notice:', error);
      return null;
    }
  }

    // Send welcome email for salon owners
  async sendWelcomeEmail(user, salon, options = {}) {
    if (!this._checkEmailEnabled()) return null;

    try {
      const mailOptions = {
        from: this.fromEmail,
        to: user.email,
        subject: 'Welcome to SalonTime - Your Salon is Almost Ready!',
        html: this._generateWelcomeEmailTemplate(user, salon, options),
      };

      const result = await this.transporter.sendMail(mailOptions);
      return result;
    } catch (error) {
      console.error('Failed to send welcome email:', error);
      return null;
    }
  }

  // Send Stripe onboarding completion email
  async sendStripeOnboardingComplete(user, salon) {
    if (!this._checkEmailEnabled()) return null;

    try {
      const mailOptions = {
        from: this.fromEmail,
        to: user.email,
        subject: 'Payment Setup Complete - Start Accepting Bookings!',
        html: this._generateStripeCompleteTemplate(user, salon),
      };

      const result = await this.transporter.sendMail(mailOptions);
      return result;
    } catch (error) {
      console.error('Failed to send Stripe completion email:', error);
      return null;
    }
  }
  async sendPaymentReceipt(payment, booking, client, salon) {
    if (!this._checkEmailEnabled()) return null;

    try {
      const mailOptions = {
        from: this.fromEmail,
        to: client.email,
        subject: 'Payment Receipt - SalonTime',
        html: this._generatePaymentReceiptTemplate(payment, booking, client, salon),
      };

      const result = await this.transporter.sendMail(mailOptions);
      return result;
    } catch (error) {
      console.error('Failed to send payment receipt:', error);
      return null;
    }
  }

  // Send waitlist confirmation email
  async sendWaitlistConfirmation(waitlistEntry, client, salon) {
    if (!this._checkEmailEnabled()) return null;

    try {
      const mailOptions = {
        from: this.fromEmail,
        to: client.email,
        subject: 'Waitlist Confirmation - SalonTime',
        html: this._generateWaitlistConfirmationTemplate(waitlistEntry, client, salon),
      };

      const result = await this.transporter.sendMail(mailOptions);
      return result;
    } catch (error) {
      console.error('Failed to send waitlist confirmation email:', error);
      return null;
    }
  }

  // Send waitlist notification when slot becomes available
  async sendWaitlistNotification(waitlistEntry, client, salon) {
    if (!this._checkEmailEnabled()) return null;

    try {
      const mailOptions = {
        from: this.fromEmail,
        to: client.email,
        subject: 'Appointment Slot Available - SalonTime',
        html: this._generateWaitlistNotificationTemplate(waitlistEntry, client, salon),
      };

      const result = await this.transporter.sendMail(mailOptions);
      return result;
    } catch (error) {
      console.error('Failed to send waitlist notification email:', error);
      return null;
    }
  }

  // Generate booking confirmation template
  _generateBookingConfirmationTemplate(booking, client, salon) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #FF6B35; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .booking-details { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; }
          .footer { text-align: center; padding: 20px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Booking Confirmed!</h1>
          </div>
          <div class="content">
            <p>Hi ${client.first_name},</p>
            <p>Your appointment has been confirmed. Here are the details:</p>
            
            <div class="booking-details">
              <h3>Appointment Details</h3>
              <p><strong>Salon:</strong> ${salon.business_name}</p>
              <p><strong>Date:</strong> ${booking.appointment_date}</p>
              <p><strong>Time:</strong> ${booking.start_time} - ${booking.end_time}</p>
              <p><strong>Service:</strong> ${booking.service_name}</p>
              ${booking.total_amount ? `<p><strong>Total:</strong> €${booking.total_amount}</p>` : ''}
              ${booking.client_notes ? `<p><strong>Notes:</strong> ${booking.client_notes}</p>` : ''}
            </div>
            
            <p>If you need to cancel or reschedule, please contact the salon directly or use the SalonTime app.</p>
          </div>
          <div class="footer">
            <p>Thank you for using SalonTime!</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  // Generate booking reminder template
  _generateBookingReminderTemplate(booking, client, salon) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #FF6B35; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .reminder { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 8px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Appointment Reminder</h1>
          </div>
          <div class="content">
            <p>Hi ${client.first_name},</p>
            <div class="reminder">
              <p><strong>Don't forget!</strong> You have an appointment tomorrow:</p>
              <p><strong>Salon:</strong> ${salon.business_name}</p>
              <p><strong>Date:</strong> ${booking.appointment_date}</p>
              <p><strong>Time:</strong> ${booking.start_time}</p>
            </div>
            <p>We look forward to seeing you!</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  // Generate booking reschedule template (for client)
  _generateBookingRescheduleTemplate(booking, client, salon, oldDate, oldTime) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #3498db; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .booking-details { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; }
          .change-notice { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 15px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Appointment Rescheduled</h1>
          </div>
          <div class="content">
            <p>Hi ${client.first_name},</p>
            <p>Your appointment has been rescheduled. Here are the updated details:</p>
            
            <div class="change-notice">
              <p><strong>Previous Date/Time:</strong> ${oldDate} at ${oldTime}</p>
            </div>
            
            <div class="booking-details">
              <h3>New Appointment Details</h3>
              <p><strong>Salon:</strong> ${salon.business_name}</p>
              <p><strong>Date:</strong> ${booking.appointment_date}</p>
              <p><strong>Time:</strong> ${booking.start_time} - ${booking.end_time}</p>
              <p><strong>Service:</strong> ${booking.service_name}</p>
              <p><strong>Status:</strong> ${booking.status}</p>
            </div>
            
            <p>The salon will be notified of this change and will confirm the new time.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  // Generate salon reschedule notice template (for salon owner)
  _generateSalonRescheduleNoticeTemplate(booking, client, salon, oldDate, oldTime) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #e67e22; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .booking-details { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; }
          .change-notice { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 15px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Booking Rescheduled</h1>
          </div>
          <div class="content">
            <p>Hi,</p>
            <p>A client has rescheduled their appointment. Please confirm the new time in your SalonTime dashboard.</p>
            
            <div class="change-notice">
              <p><strong>Previous Date/Time:</strong> ${oldDate} at ${oldTime}</p>
            </div>
            
            <div class="booking-details">
              <h3>New Appointment Details</h3>
              <p><strong>Client:</strong> ${client.first_name} ${client.last_name}</p>
              <p><strong>Email:</strong> ${client.email}</p>
              <p><strong>Phone:</strong> ${client.phone || 'Not provided'}</p>
              <p><strong>Date:</strong> ${booking.appointment_date}</p>
              <p><strong>Time:</strong> ${booking.start_time} - ${booking.end_time}</p>
              <p><strong>Service:</strong> ${booking.service_name}</p>
              <p><strong>Status:</strong> ${booking.status} (requires your confirmation)</p>
            </div>
            
            <p>Please log into your SalonTime dashboard to confirm or adjust this appointment.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  // Generate cancellation template
  _generateCancellationTemplate(booking, client, salon, reason) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #e74c3c; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Appointment Cancelled</h1>
          </div>
          <div class="content">
            <p>Hi ${client.first_name},</p>
            <p>Your appointment has been cancelled:</p>
            <p><strong>Salon:</strong> ${salon.business_name}</p>
            <p><strong>Date:</strong> ${booking.appointment_date}</p>
            <p><strong>Time:</strong> ${booking.start_time}</p>
            ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
            <p>You can book a new appointment anytime using the SalonTime app.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  // Generate payment receipt template
  _generatePaymentReceiptTemplate(payment, booking, client, salon) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #27ae60; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .receipt { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Payment Receipt</h1>
          </div>
          <div class="content">
            <p>Hi ${client.first_name},</p>
            <p>Thank you for your payment. Here's your receipt:</p>
            
            <div class="receipt">
              <h3>Receipt #${payment.id}</h3>
              <p><strong>Date:</strong> ${payment.created_at}</p>
              <p><strong>Amount:</strong> €${payment.amount}</p>
              <p><strong>Payment Method:</strong> ${payment.payment_method?.type || 'Card'}</p>
              <p><strong>Service:</strong> ${booking.service_name}</p>
              <p><strong>Salon:</strong> ${salon.business_name}</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  // Generate welcome email template
  _generateWelcomeEmailTemplate(user, salon, options) {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Welcome to SalonTime</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 30px; }
            .footer { background: #333; color: white; padding: 20px; text-align: center; border-radius: 0 0 10px 10px; }
            .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
            .steps { background: white; padding: 20px; border-radius: 5px; margin: 20px 0; }
            .step { margin: 10px 0; padding: 10px; border-left: 4px solid #667eea; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎉 Welcome to SalonTime!</h1>
              <p>Your salon "${salon.business_name}" has been created successfully</p>
            </div>
            
            <div class="content">
              <h2>Hi ${user.full_name}!</h2>
              
              <p>Congratulations! You've successfully joined SalonTime as a salon owner. Your salon profile has been created and you're almost ready to start accepting bookings.</p>
              
              <div class="steps">
                <h3>📋 Next Steps to Complete Your Setup:</h3>
                
                ${options.stripe_setup_required ? `
                  <div class="step">
                    <h4>1. Complete Payment Setup</h4>
                    <p>Set up your Stripe account to receive payments from customers.</p>
                    ${options.onboarding_url ? `<a href="${options.onboarding_url}" class="button">Complete Payment Setup</a>` : ''}
                  </div>
                ` : `
                  <div class="step">
                    <h4>✅ Payment Setup Complete</h4>
                    <p>Your Stripe account is ready to receive payments!</p>
                  </div>
                `}
                
                <div class="step">
                  <h4>2. Add Your Services</h4>
                  <p>Add the services you offer with pricing and duration.</p>
                </div>
                
                <div class="step">
                  <h4>3. Set Business Hours</h4>
                  <p>Configure when customers can book appointments.</p>
                </div>
                
                <div class="step">
                  <h4>4. Activate Your Salon</h4>
                  <p>Once everything is set up, activate your salon for bookings.</p>
                </div>
              </div>
              
              <h3>📱 Your Salon Details:</h3>
              <ul>
                <li><strong>Business Name:</strong> ${salon.business_name}</li>
                <li><strong>Email:</strong> ${salon.email}</li>
                <li><strong>Phone:</strong> ${salon.phone}</li>
                <li><strong>Address:</strong> ${salon.address ? `${salon.address.street}, ${salon.address.city}, ${salon.address.state}` : 'Not provided'}</li>
              </ul>
              
              <p>If you have any questions or need help, don't hesitate to contact our support team.</p>
            </div>
            
            <div class="footer">
              <p>&copy; 2024 SalonTime. All rights reserved.</p>
              <p>Need help? Contact us at ${config.business.support_email}</p>
            </div>
          </div>
        </body>
      </html>
    `;
  }

  // Generate Stripe onboarding completion template
  _generateStripeCompleteTemplate(user, salon) {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Payment Setup Complete</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #2ECC71 0%, #27AE60 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 30px; }
            .footer { background: #333; color: white; padding: 20px; text-align: center; border-radius: 0 0 10px 10px; }
            .success-icon { font-size: 48px; text-align: center; margin: 20px 0; }
            .feature { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #2ECC71; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <div class="success-icon">✅</div>
              <h1>Payment Setup Complete!</h1>
              <p>Your salon is now ready to accept bookings and payments</p>
            </div>
            
            <div class="content">
              <h2>Congratulations, ${user.full_name}!</h2>
              
              <p>Your Stripe payment account has been successfully set up for <strong>${salon.business_name}</strong>. You can now:</p>
              
              <div class="feature">
                <h4>💳 Accept Payments</h4>
                <p>Securely process customer payments for all your services</p>
              </div>
              
              <div class="feature">
                <h4>📊 Track Revenue</h4>
                <p>View detailed analytics and revenue reports in your dashboard</p>
              </div>
              
              <div class="feature">
                <h4>💰 Automatic Payouts</h4>
                <p>Receive payments directly to your bank account</p>
              </div>
              
              <div class="feature">
                <h4>🔒 Secure Processing</h4>
                <p>All payments are processed securely through Stripe</p>
              </div>
              
              <p><strong>What's Next?</strong></p>
              <ul>
                <li>Add your services and pricing</li>
                <li>Set up your availability calendar</li>
                <li>Start accepting bookings from customers</li>
                <li>Monitor your revenue in the dashboard</li>
              </ul>
              
              <p>Welcome to the SalonTime community! We're excited to help grow your business.</p>
            </div>
            
            <div class="footer">
              <p>&copy; 2024 SalonTime. All rights reserved.</p>
              <p>Questions about payments? Contact ${config.business.support_email}</p>
            </div>
          </div>
        </body>
      </html>
    `;
  }

  // Generate waitlist confirmation template
  _generateWaitlistConfirmationTemplate(waitlistEntry, client, salon) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #FF6B35; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .waitlist-details { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; }
          .footer { text-align: center; padding: 20px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Added to Waitlist!</h1>
          </div>
          <div class="content">
            <p>Hi ${client.first_name},</p>
            <p>You've been added to the waitlist for your requested appointment. We'll notify you as soon as a slot becomes available.</p>

            <div class="waitlist-details">
              <h3>Waitlist Details</h3>
              <p><strong>Salon:</strong> ${salon.business_name}</p>
              <p><strong>Requested Date:</strong> ${waitlistEntry.requested_date}</p>
              ${waitlistEntry.requested_time ? `<p><strong>Preferred Time:</strong> ${waitlistEntry.requested_time}</p>` : ''}
              <p><strong>Service:</strong> ${waitlistEntry.service_name}</p>
              ${waitlistEntry.preferred_time_range ? `<p><strong>Time Range:</strong> ${waitlistEntry.preferred_time_range}</p>` : ''}
              <p><strong>Position:</strong> You'll be notified when your turn comes up</p>
            </div>

            <p><strong>What happens next?</strong></p>
            <ul>
              <li>We'll monitor for cancellations and availability</li>
              <li>You'll receive an email when a slot opens up</li>
              <li>You'll have a limited time to book the available slot</li>
              <li>If you don't respond, the slot may go to the next person</li>
            </ul>

            <p>You can manage your waitlist entries in the SalonTime app.</p>
          </div>
          <div class="footer">
            <p>Thank you for using SalonTime!</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  // Generate waitlist notification template
  _generateWaitlistNotificationTemplate(waitlistEntry, client, salon) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #28a745; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .notification { background: #d4edda; border: 1px solid #c3e6cb; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .action-button { display: inline-block; background: #FF6B35; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 10px 0; }
          .footer { text-align: center; padding: 20px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🎉 Slot Available!</h1>
          </div>
          <div class="content">
            <p>Hi ${client.first_name},</p>

            <div class="notification">
              <h3>Great news! An appointment slot has opened up for you!</h3>
              <p>A cancellation has made this time available. This is your chance to book the appointment you were waiting for.</p>
            </div>

            <div class="waitlist-details">
              <h3>Available Slot Details</h3>
              <p><strong>Salon:</strong> ${salon.business_name}</p>
              <p><strong>Date:</strong> ${waitlistEntry.requested_date}</p>
              ${waitlistEntry.requested_time ? `<p><strong>Time:</strong> ${waitlistEntry.requested_time}</p>` : ''}
              <p><strong>Service:</strong> ${waitlistEntry.service_name}</p>
            </div>

            <p><strong>⏰ Limited Time Offer</strong></p>
            <p>You have 24 hours to book this slot before it becomes available to others on the waitlist.</p>

            <div style="text-align: center; margin: 30px 0;">
              <a href="#" class="action-button">Book This Slot Now</a>
            </div>

            <p>If you can't make this time, you can:
            <ul>
              <li>Book a different available time</li>
              <li>Stay on the waitlist for future openings</li>
              <li>Remove yourself from the waitlist</li>
            </ul>

            <p>Don't miss this opportunity!</p>
          </div>
          <div class="footer">
            <p>Thank you for using SalonTime!</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  // Send review notification email to salon owner
  async sendReviewNotification(data) {
    if (!this._checkEmailEnabled()) return null;

    try {
      const mailOptions = {
        from: this.fromEmail,
        to: data.salon.email,
        subject: `New Review Received - ${data.salon.business_name}`,
        html: this._generateReviewNotificationTemplate(data),
      };

      const result = await this.transporter.sendMail(mailOptions);
      return result;
    } catch (error) {
      console.error('Failed to send review notification email:', error);
      return null;
    }
  }

  // Generate review notification template
  _generateReviewNotificationTemplate(data) {
    const clientName = `${data.client.first_name} ${data.client.last_name}`.trim() || 'A client';
    const stars = '⭐'.repeat(data.review.rating);
    const emptyStars = '☆'.repeat(5 - data.review.rating);
    const formattedDate = new Date(data.review.created_at).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
          .content { background: #f9f9f9; padding: 30px; }
          .review-card { background: white; padding: 25px; margin: 20px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          .rating { font-size: 24px; color: #FFD700; margin: 15px 0; }
          .comment { background: #f5f5f5; padding: 15px; border-left: 4px solid #667eea; margin: 15px 0; border-radius: 4px; font-style: italic; }
          .details { background: white; padding: 20px; margin: 15px 0; border-radius: 8px; }
          .detail-row { margin: 10px 0; padding: 8px 0; border-bottom: 1px solid #eee; }
          .detail-row:last-child { border-bottom: none; }
          .detail-label { font-weight: bold; color: #666; display: inline-block; width: 120px; }
          .detail-value { color: #333; }
          .footer { background: #333; color: white; padding: 20px; text-align: center; border-radius: 0 0 10px 10px; font-size: 12px; }
          .no-comment { color: #999; font-style: italic; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⭐ New Review Received!</h1>
            <p>${data.salon.business_name}</p>
          </div>
          
          <div class="content">
            <p>Hi ${data.owner.first_name},</p>
            <p>Great news! You've received a new review from <strong>${clientName}</strong>.</p>
            
            <div class="review-card">
              <h2 style="margin-top: 0; color: #667eea;">Review Details</h2>
              
              <div class="rating">
                ${stars}${emptyStars} <span style="font-size: 18px; color: #333; margin-left: 10px;">${data.review.rating} out of 5 stars</span>
              </div>
              
              <div class="details">
                <div class="detail-row">
                  <span class="detail-label">Client:</span>
                  <span class="detail-value">${clientName}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Service:</span>
                  <span class="detail-value">${data.review.service_name}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Date:</span>
                  <span class="detail-value">${formattedDate}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Rating:</span>
                  <span class="detail-value">${data.review.rating} / 5</span>
                </div>
              </div>
              
              ${data.review.comment ? `
                <div class="comment">
                  <strong>Comment:</strong><br>
                  "${data.review.comment}"
                </div>
              ` : `
                <div class="no-comment">
                  No comment provided with this review.
                </div>
              `}
            </div>
            
            <p>This review is now visible on your salon's profile page. Keep up the great work!</p>
            
            <p style="margin-top: 30px;">
              <strong>💡 Tip:</strong> Responding to reviews helps build trust with potential customers. 
              Consider thanking your clients for their feedback!
            </p>
          </div>
          
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} SalonTime. All rights reserved.</p>
            <p>This is an automated notification. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }
}

module.exports = new EmailService();

