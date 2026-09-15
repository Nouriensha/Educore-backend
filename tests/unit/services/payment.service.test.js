const crypto = require('crypto');
const mongoose = require('mongoose');
const paymentService = require('../../../src/services/payment.service');
const Payment = require('../../../src/models/payment.model');
const Enrollment = require('../../../src/models/enrollment.model');
const Course = require('../../../src/models/course.model');
const Progress = require('../../../src/models/progress.model');
const User = require('../../../src/models/user.model');
const EnrollmentRequest = require('../../../src/models/enrollmentRequest.model');
const env = require('../../../src/config/env');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { buildUser } = require('../../fixtures/user.fixture');
const { buildCourse } = require('../../fixtures/course.fixture');
const { buildEnrollment } = require('../../fixtures/enrollment.fixture');

// Mock external Razorpay config
jest.mock('../../../src/config/razorpay', () => ({
  payments: {
    fetch: jest.fn().mockImplementation((paymentId) => Promise.resolve({
      id: paymentId,
      amount: 499900, // 4999 INR in paise
      currency: 'INR',
      status: 'captured'
    }))
  },
  orders: {
    create: jest.fn().mockResolvedValue({ id: 'order_mock_razorpay', amount: 499900, currency: 'INR' }),
    fetch: jest.fn().mockResolvedValue({ id: 'order_mock_razorpay', status: 'paid' })
  }
}));

// Mock PDF generation utility
jest.mock('../../../src/utils/pdf.util', () => ({
  generateInvoicePdf: jest.fn().mockResolvedValue(Buffer.from('MOCK_INVOICE_PDF_BUFFER'))
}));

// Mock Email Service
jest.mock('../../../src/services/email.service', () => ({
  sendPaymentSuccessEmail: jest.fn().mockResolvedValue(true)
}));

// Mock Notification Service
jest.mock('../../../src/services/notification.service', () => ({
  triggerNewEnrollmentNotification: jest.fn().mockResolvedValue(true),
  triggerEnrollmentConfirmedNotification: jest.fn().mockResolvedValue(true),
  triggerPaymentSuccessNotification: jest.fn().mockResolvedValue(true)
}));

// Mock Institutions Service
jest.mock('../../../src/services/institutions.service', () => ({
  processPaymentSuccessInTransaction: jest.fn().mockResolvedValue({
    status: 'success',
    message: 'Institution payment processed in transaction'
  })
}));

// Mock Audit Service
jest.mock('../../../src/services/audit.service', () => ({
  logAdminAction: jest.fn().mockResolvedValue(true)
}));

const razorpay = require('../../../src/config/razorpay');
const { generateInvoicePdf } = require('../../../src/utils/pdf.util');
const emailService = require('../../../src/services/email.service');
const notificationService = require('../../../src/services/notification.service');
const institutionsService = require('../../../src/services/institutions.service');
const auditService = require('../../../src/services/audit.service');

const TEST_WEBHOOK_SECRET = 'test_razorpay_webhook_secret_key_32c';
const TEST_KEY_SECRET = 'test_razorpay_api_secret_key_32chars';

const generateWebhookSignature = (rawBody, secret = TEST_WEBHOOK_SECRET) => {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
};

const generatePaymentSignature = (orderId, paymentId, secret = TEST_KEY_SECRET) => {
  return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
};

describe('Payment Service Comprehensive Unit Tests', () => {
  let learner;
  let tutor;
  let testCourse;
  let originalWebhookSecret;
  let originalKeySecret;

  beforeAll(async () => {
    await connectDB();
    originalWebhookSecret = env.razorpay.webhookSecret;
    originalKeySecret = env.razorpay.keySecret;
  });

  afterAll(async () => {
    env.razorpay.webhookSecret = originalWebhookSecret;
    env.razorpay.keySecret = originalKeySecret;
    await closeDB();
  });

  beforeEach(async () => {
    await clearDB();
    jest.clearAllMocks();

    // Default test secrets
    env.razorpay.webhookSecret = TEST_WEBHOOK_SECRET;
    env.razorpay.keySecret = TEST_KEY_SECRET;

    tutor = await User.create(buildUser('tutor'));
    learner = await User.create(buildUser('learner'));
    testCourse = await Course.create(buildCourse(tutor._id, {
      price: 49.99,
      isFree: false,
      enrollmentCount: 0
    }));
  });

  // =========================================================================
  // 1. Webhook Signature Validation & Error Handling
  // =========================================================================
  describe('Webhook Signature Validation & Configuration', () => {
    test('should throw error when webhook secret is not configured in env', async () => {
      env.razorpay.webhookSecret = '';
      const payload = { event: 'payment.captured' };
      const rawBody = JSON.stringify(payload);
      const signature = 'some_sig';

      await expect(paymentService.handleWebhook(payload, rawBody, signature))
        .rejects
        .toThrow('Webhook secret is not configured');
    });

    test('should throw error when webhook signature does not match expected HMAC digest', async () => {
      const payload = { event: 'payment.captured' };
      const rawBody = JSON.stringify(payload);
      const invalidSignature = 'invalid_hmac_hex_signature';

      await expect(paymentService.handleWebhook(payload, rawBody, invalidSignature))
        .rejects
        .toThrow('Invalid webhook signature');
    });

    test('should return ignored status for unhandled/unknown webhook event types', async () => {
      const payload = { event: 'subscription.charged' };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      const result = await paymentService.handleWebhook(payload, rawBody, signature);

      expect(result).toEqual({
        status: 'ignored',
        message: 'Event subscription.charged ignored'
      });
    });
  });

  // =========================================================================
  // 2. Payment Success Webhook (payment.captured / order.paid)
  // =========================================================================
  describe('handleWebhook: Payment Success (order.paid & payment.captured)', () => {
    test('should return already_processed if payment record exists with success status (idempotency)', async () => {
      const transactionId = 'pay_tx_already_paid_123';
      await Payment.create({
        learnerId: learner._id,
        courseId: testCourse._id,
        amount: 49.99,
        currency: 'INR',
        transactionId,
        orderId: 'order_already_paid_123',
        paymentStatus: 'success',
        gateway: 'razorpay'
      });

      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: transactionId,
              order_id: 'order_already_paid_123',
              amount: 4999,
              currency: 'INR'
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      const result = await paymentService.handleWebhook(payload, rawBody, signature);

      expect(result).toEqual({
        status: 'already_processed',
        message: 'Payment already processed'
      });
    });

    test('should throw error if orderId has no corresponding Enrollment or EnrollmentRequest', async () => {
      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_tx_unmatched_123',
              order_id: 'order_nonexistent_999',
              amount: 4999,
              currency: 'INR'
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      await expect(paymentService.handleWebhook(payload, rawBody, signature))
        .rejects
        .toThrow('No pending enrollment found for orderId: order_nonexistent_999');
    });

    test('should activate enrollment, record payment, initialize progress, increment count and send notifications on payment.captured', async () => {
      const orderId = 'order_valid_captured_123';
      const transactionId = 'pay_valid_captured_123';

      const enrollment = await Enrollment.create(buildEnrollment(learner._id, testCourse._id, {
        enrollmentType: 'paid',
        status: 'pending_payment',
        paymentStatus: 'pending',
        paymentReference: orderId,
        billingAddress: '123 Test St, Test City',
        billingPhone: '+919876543210'
      }));

      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: transactionId,
              order_id: orderId,
              amount: 4999, // 49.99 INR in paise
              currency: 'INR'
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      const result = await paymentService.handleWebhook(payload, rawBody, signature);

      expect(result).toEqual({
        status: 'success',
        message: 'Payment processed and enrollment activated'
      });

      // 1. Verify Payment document in MongoDB
      const savedPayment = await Payment.findOne({ transactionId });
      expect(savedPayment).toBeTruthy();
      expect(savedPayment.learnerId.toString()).toBe(learner._id.toString());
      expect(savedPayment.courseId.toString()).toBe(testCourse._id.toString());
      expect(savedPayment.amount).toBe(49.99);
      expect(savedPayment.currency).toBe('INR');
      expect(savedPayment.paymentStatus).toBe('success');
      expect(savedPayment.webhookVerified).toBe(true);
      expect(savedPayment.billingAddress).toBe('123 Test St, Test City');
      expect(savedPayment.billingPhone).toBe('+919876543210');
      expect(savedPayment.paidAt).toBeInstanceOf(Date);

      // 2. Verify Enrollment updated in MongoDB
      const updatedEnrollment = await Enrollment.findById(enrollment._id);
      expect(updatedEnrollment.status).toBe('active');
      expect(updatedEnrollment.paymentStatus).toBe('success');
      expect(updatedEnrollment.amountPaid).toBe(49.99);
      expect(updatedEnrollment.paymentId).toBe(transactionId);

      // 3. Verify Progress initialized
      const progress = await Progress.findOne({ userId: learner._id, courseId: testCourse._id });
      expect(progress).toBeTruthy();
      expect(progress.completedLessons).toEqual([]);

      // 4. Verify Course enrollmentCount incremented
      const updatedCourse = await Course.findById(testCourse._id);
      expect(updatedCourse.enrollmentCount).toBe(1);

      // 5. Verify Notifications triggered
      expect(notificationService.triggerNewEnrollmentNotification).toHaveBeenCalledWith({
        studentId: learner._id,
        courseId: testCourse._id
      });
      expect(notificationService.triggerEnrollmentConfirmedNotification).toHaveBeenCalledWith({
        studentId: learner._id,
        courseId: testCourse._id
      });
      expect(notificationService.triggerPaymentSuccessNotification).toHaveBeenCalledWith({
        studentId: learner._id,
        courseId: testCourse._id,
        amount: 49.99,
        currency: 'INR',
        transactionId
      });

      // 6. Verify Invoice and Email
      expect(generateInvoicePdf).toHaveBeenCalled();
      expect(emailService.sendPaymentSuccessEmail).toHaveBeenCalledWith(expect.objectContaining({
        to: learner.email,
        name: learner.name,
        courseTitle: testCourse.title,
        amount: 49.99,
        currency: 'INR',
        transactionId
      }));
    });

    test('should activate enrollment and process identically for order.paid event', async () => {
      const orderId = 'order_paid_event_123';
      const transactionId = 'pay_order_paid_event_123';

      await Enrollment.create(buildEnrollment(learner._id, testCourse._id, {
        enrollmentType: 'paid',
        status: 'pending_payment',
        paymentStatus: 'pending',
        paymentReference: orderId
      }));

      const payload = {
        event: 'order.paid',
        payload: {
          payment: {
            entity: {
              id: transactionId,
              order_id: orderId,
              amount: 9999, // 99.99 INR
              currency: 'INR'
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      const result = await paymentService.handleWebhook(payload, rawBody, signature);

      expect(result.status).toBe('success');
      const savedPayment = await Payment.findOne({ transactionId });
      expect(savedPayment.amount).toBe(99.99);
      expect(savedPayment.paymentStatus).toBe('success');
    });

    test('should succeed and not throw if notification, invoice or email services fail', async () => {
      const orderId = 'order_resilient_notif_123';
      const transactionId = 'pay_resilient_notif_123';

      notificationService.triggerNewEnrollmentNotification.mockRejectedValueOnce(new Error('Notification error'));
      notificationService.triggerEnrollmentConfirmedNotification.mockRejectedValueOnce(new Error('Confirmed error'));
      notificationService.triggerPaymentSuccessNotification.mockRejectedValueOnce(new Error('Push error'));
      emailService.sendPaymentSuccessEmail.mockRejectedValueOnce(new Error('SMTP down'));

      await Enrollment.create(buildEnrollment(learner._id, testCourse._id, {
        enrollmentType: 'paid',
        status: 'pending_payment',
        paymentStatus: 'pending',
        paymentReference: orderId
      }));

      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: transactionId,
              order_id: orderId,
              amount: 4999,
              currency: 'INR'
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      const result = await paymentService.handleWebhook(payload, rawBody, signature);

      expect(result.status).toBe('success');
      const savedPayment = await Payment.findOne({ transactionId });
      expect(savedPayment.paymentStatus).toBe('success');
    });

    test('should record payment but skip re-activation if enrollment is already active', async () => {
      const orderId = 'order_already_active_123';
      const transactionId = 'pay_already_active_123';

      await Enrollment.create(buildEnrollment(learner._id, testCourse._id, {
        enrollmentType: 'paid',
        status: 'active',
        paymentStatus: 'success',
        paymentReference: orderId
      }));

      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: transactionId,
              order_id: orderId,
              amount: 4999,
              currency: 'INR'
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      const result = await paymentService.handleWebhook(payload, rawBody, signature);

      expect(result.status).toBe('success');
      const savedPayment = await Payment.findOne({ transactionId });
      expect(savedPayment).toBeTruthy();
      // Progress should NOT have been re-created
      const progressCount = await Progress.countDocuments({ userId: learner._id, courseId: testCourse._id });
      expect(progressCount).toBe(0);
    });

    test('should delegate to institutionsService if matched with an EnrollmentRequest', async () => {
      const orderId = 'order_institution_req_123';
      const transactionId = 'pay_institution_req_123';
      const institutionId = new mongoose.Types.ObjectId();

      const enrollmentRequest = await EnrollmentRequest.create({
        userId: learner._id,
        institutionId,
        status: 'pending_payment',
        paymentReference: orderId,
        feeSnapshot: {
          registrationFee: 500,
          joiningFee: 200,
          monthlyFee: 1000,
          totalInitialCost: 1700,
          currency: 'INR'
        },
        expiresAt: new Date(Date.now() + 86400000)
      });

      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: transactionId,
              order_id: orderId,
              amount: 170000,
              currency: 'INR'
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      const result = await paymentService.handleWebhook(payload, rawBody, signature);

      expect(institutionsService.processPaymentSuccessInTransaction).toHaveBeenCalledWith({
        enrollmentRequest: expect.objectContaining({ _id: enrollmentRequest._id }),
        transactionId,
        orderId,
        webhookVerified: true
      });
      expect(result.status).toBe('success');
    });
  });

  // =========================================================================
  // 3. Payment Failure Webhook (payment.failed)
  // =========================================================================
  describe('handleWebhook: Payment Failure (payment.failed)', () => {
    test('should record payment failure for standard course enrollment', async () => {
      const orderId = 'order_fail_course_123';
      const transactionId = 'pay_fail_course_123';

      await Enrollment.create(buildEnrollment(learner._id, testCourse._id, {
        enrollmentType: 'paid',
        status: 'pending_payment',
        paymentStatus: 'pending',
        paymentReference: orderId
      }));

      const payload = {
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: transactionId,
              order_id: orderId,
              amount: 4999,
              currency: 'INR',
              error_description: 'Payment was declined by bank due to insufficient funds'
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      const result = await paymentService.handleWebhook(payload, rawBody, signature);

      expect(result).toEqual({
        status: 'recorded_failure',
        message: 'Payment failure recorded'
      });

      const payment = await Payment.findOne({ transactionId });
      expect(payment).toBeTruthy();
      expect(payment.paymentStatus).toBe('failed');
      expect(payment.webhookVerified).toBe(true);
      expect(payment.amount).toBe(49.99);
      expect(payment.metadata.error).toBe('Payment was declined by bank due to insufficient funds');
    });

    test('should record payment failure and log audit for institutional EnrollmentRequest', async () => {
      const orderId = 'order_fail_inst_req_123';
      const transactionId = 'pay_fail_inst_req_123';
      const institutionId = new mongoose.Types.ObjectId();

      const enrollmentRequest = await EnrollmentRequest.create({
        userId: learner._id,
        institutionId,
        status: 'pending_payment',
        paymentReference: orderId,
        feeSnapshot: {
          registrationFee: 500,
          joiningFee: 200,
          monthlyFee: 1000,
          totalInitialCost: 1700,
          currency: 'INR'
        },
        expiresAt: new Date(Date.now() + 86400000)
      });

      const payload = {
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: transactionId,
              order_id: orderId,
              amount: 170000,
              currency: 'INR',
              error_description: 'Card expired'
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      const result = await paymentService.handleWebhook(payload, rawBody, signature);

      expect(result).toEqual({
        status: 'recorded_failure',
        message: 'Institution payment failure recorded'
      });

      // EnrollmentRequest updated to failed
      const updatedReq = await EnrollmentRequest.findById(enrollmentRequest._id);
      expect(updatedReq.status).toBe('failed');

      // Payment created
      const payment = await Payment.findOne({ transactionId });
      expect(payment).toBeTruthy();
      expect(payment.institutionId.toString()).toBe(institutionId.toString());
      expect(payment.paymentStatus).toBe('failed');

      // Audit logged
      expect(auditService.logAdminAction).toHaveBeenCalledWith(expect.objectContaining({
        actorUserId: learner._id,
        action: 'PAYMENT_FAILED',
        metadata: expect.objectContaining({
          requestId: enrollmentRequest._id,
          reason: 'Card expired'
        })
      }));
    });

    test('should return error status if neither Enrollment nor EnrollmentRequest found on failure', async () => {
      const payload = {
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_fail_orphan_123',
              order_id: 'order_orphan_999',
              amount: 1000,
              currency: 'INR',
              error_description: 'Authentication failure'
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      const result = await paymentService.handleWebhook(payload, rawBody, signature);

      expect(result).toEqual({
        status: 'error',
        message: 'Enrollment not found for failed payment'
      });
    });
  });

  // =========================================================================
  // 4. Refund Webhooks (refund.processed & refund.failed)
  // =========================================================================
  describe('handleWebhook: Refund Events', () => {
    test('should return ignored if refund payload entity is missing', async () => {
      const payload = {
        event: 'refund.processed',
        payload: {}
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      const result = await paymentService.handleWebhook(payload, rawBody, signature);

      expect(result).toEqual({
        status: 'ignored',
        message: 'Refund payload missing'
      });
    });

    test('should return ignored if no payment matches refund id or transaction id', async () => {
      const payload = {
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_unknown_123',
              payment_id: 'pay_unknown_123',
              amount: 4999
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      const result = await paymentService.handleWebhook(payload, rawBody, signature);

      expect(result).toEqual({
        status: 'ignored',
        message: 'No payment found for refund rfnd_unknown_123'
      });
    });

    test('should process refund.processed: update payment, soft delete enrollment & progress, decrement course count', async () => {
      const transactionId = 'pay_to_refund_123';
      const refundId = 'rfnd_proc_123';

      await Course.findByIdAndUpdate(testCourse._id, { enrollmentCount: 5 });

      const payment = await Payment.create({
        learnerId: learner._id,
        courseId: testCourse._id,
        amount: 49.99,
        currency: 'INR',
        transactionId,
        orderId: 'order_to_refund_123',
        paymentStatus: 'refund_pending',
        gateway: 'razorpay'
      });

      const enrollment = await Enrollment.create(buildEnrollment(learner._id, testCourse._id, {
        enrollmentType: 'paid',
        status: 'refund_pending',
        paymentStatus: 'refund_pending',
        deletedAt: null
      }));

      await Progress.create({
        userId: learner._id,
        courseId: testCourse._id,
        completedLessons: [],
        deletedAt: null
      });

      const payload = {
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: refundId,
              payment_id: transactionId,
              amount: 4999, // 49.99 INR
              status: 'processed'
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      const result = await paymentService.handleWebhook(payload, rawBody, signature);

      expect(result).toEqual({
        status: 'success',
        message: 'Refund event refund.processed processed'
      });

      // 1. Verify Payment document
      const updatedPayment = await Payment.findById(payment._id);
      expect(updatedPayment.paymentStatus).toBe('refunded');
      expect(updatedPayment.razorpayRefundId).toBe(refundId);
      expect(updatedPayment.refundStatus).toBe('processed');
      expect(updatedPayment.refundAmount).toBe(49.99);
      expect(updatedPayment.refundProcessedAt).toBeInstanceOf(Date);

      // 2. Verify Enrollment document soft deleted
      const updatedEnrollment = await Enrollment.findById(enrollment._id);
      expect(updatedEnrollment.status).toBe('refunded');
      expect(updatedEnrollment.paymentStatus).toBe('refunded');
      expect(updatedEnrollment.deletedAt).toBeInstanceOf(Date);

      // 3. Verify Progress soft deleted
      const updatedProgress = await Progress.findOne({ userId: learner._id, courseId: testCourse._id });
      expect(updatedProgress.deletedAt).toBeInstanceOf(Date);

      // 4. Verify Course count decremented from 5 to 4
      const updatedCourse = await Course.findById(testCourse._id);
      expect(updatedCourse.enrollmentCount).toBe(4);
    });

    test('should process refund.failed: update payment, set enrollment refund_failed, and restore access if previously refunded', async () => {
      const transactionId = 'pay_refund_revert_123';
      const refundId = 'rfnd_fail_123';

      await Course.findByIdAndUpdate(testCourse._id, { enrollmentCount: 2 });

      const payment = await Payment.create({
        learnerId: learner._id,
        courseId: testCourse._id,
        amount: 49.99,
        currency: 'INR',
        transactionId,
        orderId: 'order_refund_revert_123',
        paymentStatus: 'refunded',
        razorpayRefundId: refundId,
        gateway: 'razorpay'
      });

      // Previously refunded enrollment (deletedAt set)
      const enrollment = await Enrollment.create(buildEnrollment(learner._id, testCourse._id, {
        enrollmentType: 'paid',
        status: 'refunded',
        paymentStatus: 'refunded',
        deletedAt: new Date()
      }));

      // Previously deleted progress
      await Progress.create({
        userId: learner._id,
        courseId: testCourse._id,
        completedLessons: [],
        deletedAt: new Date()
      });

      const payload = {
        event: 'refund.failed',
        payload: {
          refund: {
            entity: {
              id: refundId,
              payment_id: transactionId,
              amount: 4999,
              status: 'failed',
              error_description: 'Beneficiary bank account details invalid'
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      const result = await paymentService.handleWebhook(payload, rawBody, signature);

      expect(result).toEqual({
        status: 'success',
        message: 'Refund event refund.failed processed'
      });

      // 1. Payment document
      const updatedPayment = await Payment.findById(payment._id);
      expect(updatedPayment.paymentStatus).toBe('refund_failed');
      expect(updatedPayment.refundStatus).toBe('failed');
      expect(updatedPayment.refundFailureReason).toBe('Beneficiary bank account details invalid');

      // 2. Enrollment access restored (deletedAt: null)
      const updatedEnrollment = await Enrollment.findById(enrollment._id);
      expect(updatedEnrollment.status).toBe('refund_failed');
      expect(updatedEnrollment.paymentStatus).toBe('refund_failed');
      expect(updatedEnrollment.deletedAt).toBeNull();

      // 3. Progress restored (deletedAt: null)
      const updatedProgress = await Progress.findOne({ userId: learner._id, courseId: testCourse._id });
      expect(updatedProgress.deletedAt).toBeNull();

      // 4. Course count restored from 2 to 3
      const updatedCourse = await Course.findById(testCourse._id);
      expect(updatedCourse.enrollmentCount).toBe(3);
    });

    test('should retain existing refundAmount when refundPayload.amount is not a number', async () => {
      const transactionId = 'pay_non_num_amount_123';
      const payment = await Payment.create({
        learnerId: learner._id,
        courseId: testCourse._id,
        amount: 50,
        refundAmount: 50,
        currency: 'INR',
        transactionId,
        orderId: 'order_non_num_123',
        paymentStatus: 'refund_pending',
        gateway: 'razorpay'
      });

      const payload = {
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_str_amount_123',
              payment_id: transactionId,
              amount: 'not_a_number'
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      await paymentService.handleWebhook(payload, rawBody, signature);

      const updatedPayment = await Payment.findById(payment._id);
      expect(updatedPayment.refundAmount).toBe(50);
    });
  });

  // =========================================================================
  // 5. Direct Frontend Payment Verification (verifyPaymentDirect)
  // =========================================================================
  describe('verifyPaymentDirect', () => {
    test('should throw error when Razorpay secret key is not configured in env', async () => {
      env.razorpay.keySecret = '';

      await expect(paymentService.verifyPaymentDirect({
        userId: learner._id,
        courseId: testCourse._id,
        razorpay_order_id: 'order_123',
        razorpay_payment_id: 'pay_123',
        razorpay_signature: 'sig_123'
      })).rejects.toThrow('Razorpay secret key not configured');
    });

    test('should throw error on invalid payment signature', async () => {
      const orderId = 'order_sig_fail_123';
      const paymentId = 'pay_sig_fail_123';
      const invalidSignature = 'invalid_hex_signature';

      await expect(paymentService.verifyPaymentDirect({
        userId: learner._id,
        courseId: testCourse._id,
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: invalidSignature
      })).rejects.toThrow('Invalid payment signature');
    });

    test('should return already_processed if transaction has already been verified successfully (idempotency)', async () => {
      const orderId = 'order_already_verif_123';
      const paymentId = 'pay_already_verif_123';
      const signature = generatePaymentSignature(orderId, paymentId);

      await Payment.create({
        learnerId: learner._id,
        courseId: testCourse._id,
        amount: 49.99,
        currency: 'INR',
        transactionId: paymentId,
        orderId,
        paymentStatus: 'success',
        gateway: 'razorpay'
      });

      const result = await paymentService.verifyPaymentDirect({
        userId: learner._id,
        courseId: testCourse._id,
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature
      });

      expect(result).toEqual({
        status: 'already_processed',
        message: 'Payment already processed'
      });
    });

    test('should throw error if pending enrollment is not found for user and order (IDOR protection)', async () => {
      const orderId = 'order_missing_enroll_123';
      const paymentId = 'pay_missing_enroll_123';
      const signature = generatePaymentSignature(orderId, paymentId);

      // An enrollment exists for another user
      const otherUser = await User.create(buildUser('learner'));
      await Enrollment.create(buildEnrollment(otherUser._id, testCourse._id, {
        enrollmentType: 'paid',
        status: 'pending_payment',
        paymentReference: orderId
      }));

      // Learner A tries to verify Learner B's order
      await expect(paymentService.verifyPaymentDirect({
        userId: learner._id,
        courseId: testCourse._id,
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature
      })).rejects.toThrow('Pending enrollment not found for this user and order');
    });

    test('should throw error if course ID does not match enrollment', async () => {
      const orderId = 'order_course_mismatch_123';
      const paymentId = 'pay_course_mismatch_123';
      const signature = generatePaymentSignature(orderId, paymentId);

      const otherCourse = await Course.create(buildCourse(tutor._id));

      await Enrollment.create(buildEnrollment(learner._id, testCourse._id, {
        enrollmentType: 'paid',
        status: 'pending_payment',
        paymentReference: orderId
      }));

      await expect(paymentService.verifyPaymentDirect({
        userId: learner._id,
        courseId: otherCourse._id, // Mismatched course
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature
      })).rejects.toThrow('Pending enrollment not found for this user and order');
    });

    test('should fetch payment details from Razorpay, activate enrollment, initialize progress and record payment', async () => {
      const orderId = 'order_direct_success_123';
      const paymentId = 'pay_direct_success_123';
      const signature = generatePaymentSignature(orderId, paymentId);

      razorpay.payments.fetch.mockResolvedValueOnce({
        id: paymentId,
        amount: 499900, // 4999 INR in paise
        currency: 'INR',
        status: 'captured'
      });

      const enrollment = await Enrollment.create(buildEnrollment(learner._id, testCourse._id, {
        enrollmentType: 'paid',
        status: 'pending_payment',
        paymentStatus: 'pending',
        paymentReference: orderId
      }));

      const result = await paymentService.verifyPaymentDirect({
        userId: learner._id,
        courseId: testCourse._id,
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature
      });

      expect(result).toEqual({
        status: 'success',
        message: 'Payment processed and enrollment activated'
      });

      // Verify Razorpay fetch call
      expect(razorpay.payments.fetch).toHaveBeenCalledWith(paymentId);

      // Verify Payment record in MongoDB
      const savedPayment = await Payment.findOne({ transactionId: paymentId });
      expect(savedPayment).toBeTruthy();
      expect(savedPayment.amount).toBe(4999);
      expect(savedPayment.currency).toBe('INR');
      expect(savedPayment.webhookVerified).toBe(false); // Direct verification is false
      expect(savedPayment.paymentStatus).toBe('success');

      // Verify Enrollment updated
      const updatedEnrollment = await Enrollment.findById(enrollment._id);
      expect(updatedEnrollment.status).toBe('active');
      expect(updatedEnrollment.paymentStatus).toBe('success');
      expect(updatedEnrollment.amountPaid).toBe(4999);
      expect(updatedEnrollment.paymentId).toBe(paymentId);

      // Verify Progress created
      const progress = await Progress.findOne({ userId: learner._id, courseId: testCourse._id });
      expect(progress).toBeTruthy();

      // Verify Course enrollment count incremented
      const updatedCourse = await Course.findById(testCourse._id);
      expect(updatedCourse.enrollmentCount).toBe(1);
    });

    test('should ignore soft-deleted enrollments during verification', async () => {
      const orderId = 'order_deleted_enroll_123';
      const paymentId = 'pay_deleted_enroll_123';
      const signature = generatePaymentSignature(orderId, paymentId);

      await Enrollment.create(buildEnrollment(learner._id, testCourse._id, {
        enrollmentType: 'paid',
        status: 'pending_payment',
        paymentReference: orderId,
        deletedAt: new Date() // Soft-deleted
      }));

      await expect(paymentService.verifyPaymentDirect({
        userId: learner._id,
        courseId: testCourse._id,
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature
      })).rejects.toThrow('Pending enrollment not found for this user and order');
    });
  });

  // =========================================================================
  // 6. Security Boundaries & Amount / Currency Handling
  // =========================================================================
  describe('Amount & Currency Security', () => {
    test('should safely convert decimal paise to integer INR without floating point inaccuracies', async () => {
      const orderId = 'order_precise_currency_123';
      const transactionId = 'pay_precise_currency_123';

      await Enrollment.create(buildEnrollment(learner._id, testCourse._id, {
        enrollmentType: 'paid',
        status: 'pending_payment',
        paymentReference: orderId
      }));

      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: transactionId,
              order_id: orderId,
              amount: 149950, // 1499.50 INR in paise
              currency: 'INR'
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateWebhookSignature(rawBody);

      await paymentService.handleWebhook(payload, rawBody, signature);

      const savedPayment = await Payment.findOne({ transactionId });
      expect(savedPayment.amount).toBe(1499.50);
      expect(savedPayment.currency).toBe('INR');
    });
  });
});
