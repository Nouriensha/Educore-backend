const crypto = require('crypto');
const mongoose = require('mongoose');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { buildUser } = require('../../fixtures/user.fixture');

// Models
const Institution = require('../../../src/models/institution.model');
const InstitutionMembership = require('../../../src/models/institutionMembership.model');
const InstitutionFeePlan = require('../../../src/models/institutionFeePlan.model');
const EnrollmentRequest = require('../../../src/models/enrollmentRequest.model');
const Payment = require('../../../src/models/payment.model');
const User = require('../../../src/models/user.model');
const Course = require('../../../src/models/course.model');

// Config & Env
const env = require('../../../src/config/env');

// Mock Razorpay
const mockRazorpay = {
  orders: {
    create: jest.fn(),
    fetchPayments: jest.fn(),
    fetch: jest.fn()
  },
  payments: {
    fetch: jest.fn()
  }
};
jest.mock('../../../src/config/razorpay', () => mockRazorpay);

// Mock PDF Utility
const mockPdfUtil = {
  generateInstitutionInvoicePdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 Mock Institution Invoice Buffer'))
};
jest.mock('../../../src/utils/pdf.util', () => mockPdfUtil);

// Services
const auditService = require('../../../src/services/audit.service');
const emailService = require('../../../src/services/email.service');
const notificationService = require('../../../src/services/notification.service');
const institutionsService = require('../../../src/services/institutions.service');

describe('Institutions Service Comprehensive Unit Tests', () => {
  let platformAdminUser;
  let institutionAdminUser;
  let tutorUser;
  let learnerUser;
  let otherLearnerUser;
  let defaultInstitution;
  let otherInstitution;

  const TEST_KEY_SECRET = 'test_razorpay_secret_key_12345';

  beforeAll(async () => {
    await connectDB();
    env.razorpay.keySecret = TEST_KEY_SECRET;
  });

  afterAll(async () => {
    await closeDB();
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    // MongoMemoryServer transactions fallback
    jest.spyOn(mongoose, 'startSession').mockRejectedValue(new Error('Standalone Mongo'));

    // Mock audit and notification services
    jest.spyOn(auditService, 'logAdminAction').mockResolvedValue(true);
    jest.spyOn(notificationService, 'createNotification').mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
    jest.spyOn(emailService, 'sendMail').mockResolvedValue(true);

    mockPdfUtil.generateInstitutionInvoicePdf.mockResolvedValue(Buffer.from('%PDF-1.4 Mock Institution Invoice Buffer'));

    // Default Razorpay responses
    mockRazorpay.orders.create.mockResolvedValue({
      id: 'order_mock_inst_123',
      amount: 50000,
      currency: 'INR',
      status: 'created'
    });
    mockRazorpay.orders.fetchPayments.mockResolvedValue({
      items: [
        { id: 'pay_mock_123', status: 'captured', amount: 50000 }
      ]
    });

    // Create Base Users
    platformAdminUser = await User.create(
      buildUser({
        name: 'Platform Admin',
        email: 'padmin@test.com',
        role: 'platform_admin',
        status: 'active'
      })
    );

    institutionAdminUser = await User.create(
      buildUser({
        name: 'Institution Admin',
        email: 'instadmin@test.com',
        role: 'institution_admin',
        status: 'active'
      })
    );

    tutorUser = await User.create(
      buildUser({
        name: 'Tutor User',
        email: 'tutor@test.com',
        role: 'tutor',
        status: 'active'
      })
    );

    learnerUser = await User.create(
      buildUser({
        name: 'Learner User',
        email: 'learner@test.com',
        role: 'learner',
        status: 'active'
      })
    );

    otherLearnerUser = await User.create(
      buildUser({
        name: 'Other Learner',
        email: 'otherlearner@test.com',
        role: 'learner',
        status: 'active'
      })
    );

    // Create Base Institutions
    defaultInstitution = await Institution.create({
      name: 'Apex Academy',
      domain: 'apex-academy.edu',
      email: 'contact@apex.edu',
      owner: institutionAdminUser._id,
      description: 'Premier Technology Institute',
      address: '100 University Ave',
      status: 'active',
      isPublished: true,
      acceptsEnrollments: true,
      enrollmentCapacity: 100,
      metadata: { learnerCount: 0, courseCount: 0 }
    });

    otherInstitution = await Institution.create({
      name: 'Beacon University',
      domain: 'beacon.edu',
      email: 'contact@beacon.edu',
      owner: platformAdminUser._id,
      description: 'Arts and Humanities University',
      address: '200 College Road',
      status: 'active',
      isPublished: true,
      acceptsEnrollments: true,
      enrollmentCapacity: 50,
      metadata: { learnerCount: 0, courseCount: 0 }
    });

    // Link institutionAdmin and tutor to defaultInstitution
    institutionAdminUser.institutionId = defaultInstitution._id;
    await institutionAdminUser.save();

    tutorUser.institutionId = defaultInstitution._id;
    await tutorUser.save();
  });

  afterEach(async () => {
    await clearDB();
    jest.restoreAllMocks();
  });

  // ==========================================
  // 1. SEARCH
  // ==========================================
  describe('search', () => {
    it('should return published, active, and acceptsEnrollments institutions with pagination', async () => {
      const res = await institutionsService.search({ page: 1, limit: 10 });

      expect(res.institutions).toHaveLength(2);
      expect(res.pagination.total).toBe(2);
      expect(res.pagination.page).toBe(1);
      expect(res.pagination.limit).toBe(10);
      expect(res.pagination.pages).toBe(1);
    });

    it('should filter institutions by keyword matching name (case-insensitive)', async () => {
      const res = await institutionsService.search({ keyword: 'apex' });
      expect(res.institutions).toHaveLength(1);
      expect(res.institutions[0].name).toBe('Apex Academy');
    });

    it('should filter institutions by keyword matching description', async () => {
      const res = await institutionsService.search({ keyword: 'Arts' });
      expect(res.institutions).toHaveLength(1);
      expect(res.institutions[0].name).toBe('Beacon University');
    });

    it('should sort by name ascending when sort="name"', async () => {
      const res = await institutionsService.search({ sort: 'name' });
      expect(res.institutions[0].name).toBe('Apex Academy');
      expect(res.institutions[1].name).toBe('Beacon University');
    });

    it('should sort by newest first by default', async () => {
      const res = await institutionsService.search({});
      expect(res.institutions[0]._id.toString()).toBe(otherInstitution._id.toString());
      expect(res.institutions[1]._id.toString()).toBe(defaultInstitution._id.toString());
    });

    it('should exclude unpublished, inactive, or enrollment-closed institutions', async () => {
      await Institution.create({
        name: 'Closed Academy',
        domain: 'closed.edu',
        email: 'closed@closed.edu',
        owner: platformAdminUser._id,
        status: 'active',
        isPublished: true,
        acceptsEnrollments: false
      });

      await Institution.create({
        name: 'Inactive Academy',
        domain: 'inactive.edu',
        email: 'inactive@inactive.edu',
        owner: platformAdminUser._id,
        status: 'suspended',
        isPublished: true,
        acceptsEnrollments: true
      });

      await Institution.create({
        name: 'Draft Academy',
        domain: 'draft.edu',
        email: 'draft@draft.edu',
        owner: platformAdminUser._id,
        status: 'active',
        isPublished: false,
        acceptsEnrollments: true
      });

      const res = await institutionsService.search({});
      expect(res.institutions).toHaveLength(2);
      const names = res.institutions.map(i => i.name);
      expect(names).not.toContain('Closed Academy');
      expect(names).not.toContain('Inactive Academy');
      expect(names).not.toContain('Draft Academy');
    });

    it('should log audit action when user is provided', async () => {
      await institutionsService.search({ keyword: 'Apex', user: learnerUser, requestMeta: { ip: '127.0.0.1' } });
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: learnerUser._id,
          action: 'INSTITUTION_SEARCH',
          metadata: expect.objectContaining({ keyword: 'Apex', resultsCount: 1 })
        })
      );
    });

    it('should not log audit action when user is not provided', async () => {
      await institutionsService.search({ keyword: 'Apex' });
      expect(auditService.logAdminAction).not.toHaveBeenCalled();
    });
  });

  // ==========================================
  // 2. GET DETAIL
  // ==========================================
  describe('getDetail', () => {
    it('should return institution details, learner count, active fee plan, and published courses', async () => {
      // Create Fee Plan
      await InstitutionFeePlan.create({
        institutionId: defaultInstitution._id,
        registrationFee: 100,
        joiningFee: 200,
        monthlyFee: 50,
        paymentRequired: true,
        currency: 'INR',
        active: true
      });

      // Create Active Membership to increment count
      await InstitutionMembership.create({
        institutionId: defaultInstitution._id,
        userId: learnerUser._id,
        memberType: 'learner',
        status: 'active'
      });

      // Create Course by Tutor
      await Course.create({
        title: 'Fullstack Mastery',
        shortDescription: 'Modern Fullstack Development',
        description: 'A comprehensive fullstack development bootcamp course.',
        category: 'Web Development',
        level: 'Intermediate',
        authorId: tutorUser._id,
        institutionId: defaultInstitution._id,
        status: 'published',
        visibility: 'public',
        price: 999,
        isFree: false
      });

      const detail = await institutionsService.getDetail({ institutionId: defaultInstitution._id });

      expect(detail.institution.name).toBe('Apex Academy');
      expect(detail.institution.metadata.learnerCount).toBe(1);
      expect(detail.feePlan.registrationFee).toBe(100);
      expect(detail.feePlan.joiningFee).toBe(200);
      expect(detail.courses).toHaveLength(1);
      expect(detail.courses[0].title).toBe('Fullstack Mastery');
    });

    it('should return default zero-fee structure when no active fee plan exists', async () => {
      const detail = await institutionsService.getDetail({ institutionId: defaultInstitution._id });
      expect(detail.feePlan).toEqual({
        registrationFee: 0,
        joiningFee: 0,
        monthlyFee: 0,
        paymentRequired: false,
        currency: 'INR'
      });
      expect(detail.courses).toHaveLength(0);
    });

    it('should throw 404 INSTITUTION_NOT_AVAILABLE if institution does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      await expect(institutionsService.getDetail({ institutionId: nonExistentId }))
        .rejects.toThrow('Institution not found or unavailable');
    });

    it('should throw 404 if institution is inactive or unpublished', async () => {
      defaultInstitution.isPublished = false;
      await defaultInstitution.save();

      await expect(institutionsService.getDetail({ institutionId: defaultInstitution._id }))
        .rejects.toThrow('Institution not found or unavailable');
    });
  });

  // ==========================================
  // 3. ENROLL (VALIDATIONS & GUARDS)
  // ==========================================
  describe('enroll - Validations & Access Guards', () => {
    it('should throw 404 USER_NOT_FOUND if user does not exist', async () => {
      const nonExistentUserId = new mongoose.Types.ObjectId();
      await expect(
        institutionsService.enroll({ userId: nonExistentUserId, institutionId: defaultInstitution._id })
      ).rejects.toThrow('User not found');
    });

    it('should throw 404 USER_NOT_FOUND if user is soft deleted', async () => {
      learnerUser.deletedAt = new Date();
      await learnerUser.save();

      await expect(
        institutionsService.enroll({ userId: learnerUser._id, institutionId: defaultInstitution._id })
      ).rejects.toThrow('User not found');
    });

    it('should throw 403 ACCOUNT_NOT_ACTIVE if user is suspended, blocked, or banned', async () => {
      learnerUser.status = 'suspended';
      await learnerUser.save();

      await expect(
        institutionsService.enroll({ userId: learnerUser._id, institutionId: defaultInstitution._id })
      ).rejects.toThrow('Account is suspended or blocked');
    });

    it('should throw 400 INSTITUTION_NOT_AVAILABLE if institution does not accept enrollments', async () => {
      defaultInstitution.acceptsEnrollments = false;
      await defaultInstitution.save();

      await expect(
        institutionsService.enroll({ userId: learnerUser._id, institutionId: defaultInstitution._id })
      ).rejects.toThrow('Institution is not accepting enrollments at this time');
    });

    it('should throw 400 INSTITUTION_CAPACITY_FULL if learnerCount reaches capacity', async () => {
      defaultInstitution.enrollmentCapacity = 5;
      defaultInstitution.metadata.learnerCount = 5;
      await defaultInstitution.save();

      // Create 5 active memberships so getDetail also reports 5
      for (let i = 0; i < 5; i++) {
        await InstitutionMembership.create({
          institutionId: defaultInstitution._id,
          userId: new mongoose.Types.ObjectId(),
          memberType: 'learner',
          status: 'active'
        });
      }

      await expect(
        institutionsService.enroll({ userId: learnerUser._id, institutionId: defaultInstitution._id })
      ).rejects.toThrow('Institution enrollment capacity is full');
    });

    it('should throw 409 ALREADY_ENROLLED if user already has an active membership', async () => {
      await InstitutionMembership.create({
        institutionId: defaultInstitution._id,
        userId: learnerUser._id,
        memberType: 'learner',
        status: 'active'
      });

      await expect(
        institutionsService.enroll({ userId: learnerUser._id, institutionId: defaultInstitution._id })
      ).rejects.toThrow('Already enrolled or enrollment request is pending');
    });

    it('should throw 409 ALREADY_ENROLLED if user has pending_payment or pending_approval membership', async () => {
      await InstitutionMembership.create({
        institutionId: defaultInstitution._id,
        userId: learnerUser._id,
        memberType: 'learner',
        status: 'pending_payment'
      });

      await expect(
        institutionsService.enroll({ userId: learnerUser._id, institutionId: defaultInstitution._id })
      ).rejects.toThrow('Already enrolled or enrollment request is pending');
    });

    it('should allow enrollment if user does not already have an active membership', async () => {
      // Free plan by default
      const res = await institutionsService.enroll({
        userId: otherLearnerUser._id,
        institutionId: defaultInstitution._id
      });
      expect(res.data.status).toBe('completed');
      expect(res.data.membership.status).toBe('active');
    });

    it('should throw 403 UNAUTHORIZED_ENROLLMENT if tutor tries to enroll into a foreign institution', async () => {
      // tutor belongs to defaultInstitution, tries to enroll into otherInstitution
      await expect(
        institutionsService.enroll({ userId: tutorUser._id, institutionId: otherInstitution._id })
      ).rejects.toThrow('Tutors can only enroll into their designated institution');
    });
  });

  // ==========================================
  // 4. ENROLL (FREE ENROLLMENT FLOW)
  // ==========================================
  describe('enroll - Free Flow', () => {
    it('should enroll learner directly when feePlan has paymentRequired=false', async () => {
      const res = await institutionsService.enroll({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id
      });

      expect(res.message).toBe('Enrollment successful.');
      expect(res.data.status).toBe('completed');
      expect(res.data.membership.memberType).toBe('learner');
      expect(res.data.membership.status).toBe('active');
      expect(res.data.membership.paymentStatus).toBe('not_required');

      // Verify DB State
      const updatedInst = await Institution.findById(defaultInstitution._id);
      expect(updatedInst.metadata.learnerCount).toBe(1);

      const membershipDoc = await InstitutionMembership.findOne({
        institutionId: defaultInstitution._id,
        userId: learnerUser._id
      });
      expect(membershipDoc).toBeTruthy();
      expect(membershipDoc.status).toBe('active');

      // Verify Notifications & Audit
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ENROLLMENT_INITIATED' })
      );
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'MEMBERSHIP_CREATED' })
      );
      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Enrollment Completed' })
      );
      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ subject: `Enrollment Completed: ${defaultInstitution.name}` })
      );
    });

    it('should enroll tutor with status pending_approval in free flow', async () => {
      const res = await institutionsService.enroll({
        userId: tutorUser._id,
        institutionId: defaultInstitution._id
      });

      expect(res.data.membership.memberType).toBe('tutor');
      expect(res.data.membership.status).toBe('pending_approval');
    });

    it('should throw 400 if atomic capacity increment check fails in race condition', async () => {
      // Mock findOneAndUpdate to return null simulating full capacity race
      jest.spyOn(Institution, 'findOneAndUpdate').mockResolvedValue(null);

      await expect(
        institutionsService.enroll({
          userId: learnerUser._id,
          institutionId: defaultInstitution._id
        })
      ).rejects.toThrow('Institution enrollment capacity is full');
    });
  });

  // ==========================================
  // 5. ENROLL (PAID FLOW / RAZORPAY)
  // ==========================================
  describe('enroll - Paid Flow (Razorpay)', () => {
    beforeEach(async () => {
      await InstitutionFeePlan.create({
        institutionId: defaultInstitution._id,
        registrationFee: 250,
        joiningFee: 250,
        monthlyFee: 50,
        paymentRequired: true,
        currency: 'INR',
        active: true
      });
    });

    it('should create Razorpay order and EnrollmentRequest with 15-min TTL', async () => {
      const res = await institutionsService.enroll({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id,
        idempotencyKey: 'idem_key_001'
      });

      expect(res.message).toBe('Enrollment initiated. Payment required.');
      expect(res.data.status).toBe('pending_payment');
      expect(res.data.paymentReference).toBe('order_mock_inst_123');
      expect(res.data.feeSnapshot.totalInitialCost).toBe(500);

      // Verify Razorpay Order Call
      expect(mockRazorpay.orders.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 50000, // 500 INR * 100 paise
          currency: 'INR'
        })
      );

      // Verify DB State
      const req = await EnrollmentRequest.findOne({ idempotencyKey: 'idem_key_001' });
      expect(req).toBeTruthy();
      expect(req.status).toBe('pending_payment');
      expect(req.paymentReference).toBe('order_mock_inst_123');
      expect(req.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // Verify Audit & Notification
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PAYMENT_STARTED' })
      );
      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Payment Initiated' })
      );
    });

    it('should return existing pending payment if idempotencyKey already exists', async () => {
      const initial = await institutionsService.enroll({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id,
        idempotencyKey: 'idem_key_dup'
      });

      const duplicate = await institutionsService.enroll({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id,
        idempotencyKey: 'idem_key_dup'
      });

      expect(duplicate.message).toBe('Existing pending payment found.');
      expect(duplicate.data.requestId.toString()).toBe(initial.data.requestId.toString());
      expect(mockRazorpay.orders.create).toHaveBeenCalledTimes(1);
    });

    it('should return pending enrollment if user already has an active pending request (concurrency gate)', async () => {
      const initial = await institutionsService.enroll({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id
      });

      const duplicate = await institutionsService.enroll({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id
      });

      expect(duplicate.message).toBe('Pending enrollment already exists.');
      expect(duplicate.data.requestId.toString()).toBe(initial.data.requestId.toString());
      expect(mockRazorpay.orders.create).toHaveBeenCalledTimes(1);
    });

    it('should throw 500 if Razorpay order creation fails', async () => {
      mockRazorpay.orders.create.mockRejectedValueOnce(new Error('Gateway timeout'));

      await expect(
        institutionsService.enroll({
          userId: learnerUser._id,
          institutionId: defaultInstitution._id
        })
      ).rejects.toThrow('Failed to initialize payment order');
    });
  });

  // ==========================================
  // 6. CANCEL REQUEST
  // ==========================================
  describe('cancelRequest', () => {
    it('should cancel pending request and log audit action', async () => {
      const req = await EnrollmentRequest.create({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id,
        status: 'pending_payment',
        feeSnapshot: { registrationFee: 100, joiningFee: 100, monthlyFee: 0, totalInitialCost: 200, currency: 'INR' },
        expiresAt: new Date(Date.now() + 10000)
      });

      const res = await institutionsService.cancelRequest({
        requestId: req._id,
        userId: learnerUser._id,
        requestMeta: { ip: '127.0.0.1' }
      });

      expect(res.message).toBe('Enrollment request cancelled successfully.');

      const updated = await EnrollmentRequest.findById(req._id);
      expect(updated.status).toBe('cancelled');

      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PAYMENT_FAILED',
          metadata: expect.objectContaining({ reason: 'cancelled_by_user' })
        })
      );
    });

    it('should throw 404 REQUEST_NOT_FOUND if request does not belong to user (IDOR check)', async () => {
      const req = await EnrollmentRequest.create({
        userId: otherLearnerUser._id,
        institutionId: defaultInstitution._id,
        status: 'pending_payment',
        feeSnapshot: { registrationFee: 100, joiningFee: 100, monthlyFee: 0, totalInitialCost: 200, currency: 'INR' },
        expiresAt: new Date(Date.now() + 10000)
      });

      await expect(
        institutionsService.cancelRequest({
          requestId: req._id,
          userId: learnerUser._id
        })
      ).rejects.toThrow('No cancelable pending request found');
    });

    it('should throw 404 if request is already completed, cancelled, or expired', async () => {
      const req = await EnrollmentRequest.create({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id,
        status: 'completed',
        feeSnapshot: { registrationFee: 100, joiningFee: 100, monthlyFee: 0, totalInitialCost: 200, currency: 'INR' },
        expiresAt: new Date(Date.now() + 10000)
      });

      await expect(
        institutionsService.cancelRequest({
          requestId: req._id,
          userId: learnerUser._id
        })
      ).rejects.toThrow('No cancelable pending request found');
    });
  });

  // ==========================================
  // 7. VERIFY PAYMENT DIRECT
  // ==========================================
  describe('verifyPaymentDirect', () => {
    let testOrder;
    let testEnrollmentRequest;

    beforeEach(async () => {
      testOrder = {
        id: 'order_test_999',
        amount: 30000,
        currency: 'INR'
      };

      testEnrollmentRequest = await EnrollmentRequest.create({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id,
        status: 'pending_payment',
        paymentReference: testOrder.id,
        feeSnapshot: {
          registrationFee: 150,
          joiningFee: 150,
          monthlyFee: 0,
          totalInitialCost: 300,
          currency: 'INR'
        },
        expiresAt: new Date(Date.now() + 15 * 60 * 1000)
      });
    });

    const generateValidSignature = (orderId, paymentId, secret = TEST_KEY_SECRET) => {
      return crypto
        .createHmac('sha256', secret)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');
    };

    it('should throw error if Razorpay keySecret is missing', async () => {
      const origSecret = env.razorpay.keySecret;
      env.razorpay.keySecret = null;

      await expect(
        institutionsService.verifyPaymentDirect({
          userId: learnerUser._id,
          requestId: testEnrollmentRequest._id,
          razorpay_order_id: testOrder.id,
          razorpay_payment_id: 'pay_123',
          razorpay_signature: 'sig_123'
        })
      ).rejects.toThrow('Razorpay secret key not configured');

      env.razorpay.keySecret = origSecret;
    });

    it('should throw 400 INVALID_SIGNATURE on mismatched signature', async () => {
      await expect(
        institutionsService.verifyPaymentDirect({
          userId: learnerUser._id,
          requestId: testEnrollmentRequest._id,
          razorpay_order_id: testOrder.id,
          razorpay_payment_id: 'pay_valid_01',
          razorpay_signature: 'invalid_tampered_signature_hex'
        })
      ).rejects.toThrow('Invalid payment signature');
    });

    it('should return already_processed if payment transactionId was already processed with success', async () => {
      const paymentId = 'pay_already_done';
      const sig = generateValidSignature(testOrder.id, paymentId);

      await Payment.create({
        learnerId: learnerUser._id,
        institutionId: defaultInstitution._id,
        paymentType: 'institution_enrollment',
        amount: 300,
        currency: 'INR',
        gateway: 'razorpay',
        transactionId: paymentId,
        orderId: testOrder.id,
        paymentStatus: 'success'
      });

      const res = await institutionsService.verifyPaymentDirect({
        userId: learnerUser._id,
        requestId: testEnrollmentRequest._id,
        razorpay_order_id: testOrder.id,
        razorpay_payment_id: paymentId,
        razorpay_signature: sig
      });

      expect(res.status).toBe('already_processed');
      expect(res.message).toBe('Payment already processed.');
    });

    it('should throw 404 REQUEST_NOT_FOUND if enrollment request does not match user or order', async () => {
      const paymentId = 'pay_valid_02';
      const sig = generateValidSignature(testOrder.id, paymentId);

      await expect(
        institutionsService.verifyPaymentDirect({
          userId: otherLearnerUser._id, // Wrong user
          requestId: testEnrollmentRequest._id,
          razorpay_order_id: testOrder.id,
          razorpay_payment_id: paymentId,
          razorpay_signature: sig
        })
      ).rejects.toThrow('Enrollment request not found for order');
    });

    it('should return already_processed if enrollmentRequest is already completed', async () => {
      testEnrollmentRequest.status = 'completed';
      await testEnrollmentRequest.save();

      const paymentId = 'pay_valid_03';
      const sig = generateValidSignature(testOrder.id, paymentId);

      const res = await institutionsService.verifyPaymentDirect({
        userId: learnerUser._id,
        requestId: testEnrollmentRequest._id,
        razorpay_order_id: testOrder.id,
        razorpay_payment_id: paymentId,
        razorpay_signature: sig
      });

      expect(res.status).toBe('already_processed');
      expect(res.message).toBe('Enrollment already completed.');
    });

    it('should verify signature and complete enrollment successfully', async () => {
      const paymentId = 'pay_success_100';
      const sig = generateValidSignature(testOrder.id, paymentId);

      const res = await institutionsService.verifyPaymentDirect({
        userId: learnerUser._id,
        requestId: testEnrollmentRequest._id,
        razorpay_order_id: testOrder.id,
        razorpay_payment_id: paymentId,
        razorpay_signature: sig
      });

      expect(res.status).toBe('success');
      expect(res.message).toBe('Enrollment successful. Payment verified.');

      // Verify DB Mutations
      const paymentDoc = await Payment.findOne({ transactionId: paymentId });
      expect(paymentDoc).toBeTruthy();
      expect(paymentDoc.amount).toBe(300);
      expect(paymentDoc.paymentStatus).toBe('success');

      const membershipDoc = await InstitutionMembership.findOne({
        institutionId: defaultInstitution._id,
        userId: learnerUser._id
      });
      expect(membershipDoc).toBeTruthy();
      expect(membershipDoc.status).toBe('active');
      expect(membershipDoc.paymentStatus).toBe('paid');

      const updatedReq = await EnrollmentRequest.findById(testEnrollmentRequest._id);
      expect(updatedReq.status).toBe('completed');
    });
  });

  // ==========================================
  // 8. PROCESS PAYMENT SUCCESS
  // ==========================================
  describe('processPaymentSuccess & processPaymentSuccessInTransaction', () => {
    let enrollmentRequest;

    beforeEach(async () => {
      enrollmentRequest = await EnrollmentRequest.create({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id,
        status: 'pending_payment',
        paymentReference: 'order_test_success_1',
        feeSnapshot: {
          registrationFee: 200,
          joiningFee: 200,
          monthlyFee: 50,
          totalInitialCost: 400,
          currency: 'INR'
        },
        expiresAt: new Date(Date.now() + 10000)
      });
    });

    it('should throw 404 USER_NOT_FOUND if user is deleted or missing', async () => {
      learnerUser.deletedAt = new Date();
      await learnerUser.save();

      await expect(
        institutionsService.processPaymentSuccess({
          enrollmentRequest,
          transactionId: 'txn_001',
          orderId: 'order_001',
          webhookVerified: false,
          session: null
        })
      ).rejects.toThrow('User no longer exists');
    });

    it('should throw 403 ACCOUNT_NOT_ACTIVE if user is banned or suspended', async () => {
      learnerUser.status = 'banned';
      await learnerUser.save();

      await expect(
        institutionsService.processPaymentSuccess({
          enrollmentRequest,
          transactionId: 'txn_001',
          orderId: 'order_001',
          webhookVerified: false,
          session: null
        })
      ).rejects.toThrow('User account is suspended or blocked');
    });

    it('should throw 404 INSTITUTION_NO_LONGER_AVAILABLE if institution is inactive', async () => {
      defaultInstitution.status = 'suspended';
      await defaultInstitution.save();

      await expect(
        institutionsService.processPaymentSuccess({
          enrollmentRequest,
          transactionId: 'txn_001',
          orderId: 'order_001',
          webhookVerified: false,
          session: null
        })
      ).rejects.toThrow('Institution is no longer available');
    });

    it('should return already_processed if active membership already exists', async () => {
      await InstitutionMembership.create({
        institutionId: defaultInstitution._id,
        userId: learnerUser._id,
        memberType: 'learner',
        status: 'active'
      });

      const res = await institutionsService.processPaymentSuccess({
        enrollmentRequest,
        transactionId: 'txn_002',
        orderId: 'order_002',
        webhookVerified: false,
        session: null
      });

      expect(res.status).toBe('already_processed');
      const updatedReq = await EnrollmentRequest.findById(enrollmentRequest._id);
      expect(updatedReq.status).toBe('completed');
    });

    it('should throw 400 INSTITUTION_CAPACITY_FULL if institution capacity is reached', async () => {
      defaultInstitution.enrollmentCapacity = 1;
      defaultInstitution.metadata.learnerCount = 1;
      await defaultInstitution.save();

      await expect(
        institutionsService.processPaymentSuccess({
          enrollmentRequest,
          transactionId: 'txn_003',
          orderId: 'order_003',
          webhookVerified: false,
          session: null
        })
      ).rejects.toThrow('Institution capacity full');
    });

    it('should process payment success, create membership, invoice, and send notifications', async () => {
      const res = await institutionsService.processPaymentSuccessInTransaction({
        enrollmentRequest,
        transactionId: 'txn_success_full',
        orderId: 'order_success_full',
        webhookVerified: true
      });

      expect(res.status).toBe('success');

      // Check Payment record
      const payment = await Payment.findOne({ transactionId: 'txn_success_full' });
      expect(payment).toBeTruthy();
      expect(payment.amount).toBe(400);
      expect(payment.paymentType).toBe('institution_enrollment');
      expect(payment.webhookVerified).toBe(true);

      // Check Membership record
      const membership = await InstitutionMembership.findOne({
        institutionId: defaultInstitution._id,
        userId: learnerUser._id
      });
      expect(membership.status).toBe('active');
      expect(membership.paymentStatus).toBe('paid');

      // Check Learner Count increment
      const updatedInst = await Institution.findById(defaultInstitution._id);
      expect(updatedInst.metadata.learnerCount).toBe(1);

      // Check Side Effects (PDF invoice, email, notifications, audit)
      expect(mockPdfUtil.generateInstitutionInvoicePdf).toHaveBeenCalled();
      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({ name: 'Invoice-txn_success_full.pdf' })
          ])
        })
      );
      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Payment Successful!' })
      );
      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Enrollment Activated' })
      );
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PAYMENT_COMPLETED' })
      );
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ENROLLMENT_COMPLETED' })
      );
    });

    it('should trigger CAPACITY_WARNING when learner count reaches >= 80% capacity', async () => {
      defaultInstitution.enrollmentCapacity = 10;
      defaultInstitution.metadata.learnerCount = 7; // will become 8 (80%)
      await defaultInstitution.save();

      await institutionsService.processPaymentSuccess({
        enrollmentRequest,
        transactionId: 'txn_warn_80',
        orderId: 'order_warn_80',
        webhookVerified: false,
        session: null
      });

      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CAPACITY_WARNING',
          metadata: expect.objectContaining({ fillPercent: 80 })
        })
      );
      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Capacity Warning' })
      );
    });

    it('should not fail enrollment if invoice generation throws an error', async () => {
      mockPdfUtil.generateInstitutionInvoicePdf.mockRejectedValueOnce(new Error('PDFKit Error'));

      const res = await institutionsService.processPaymentSuccess({
        enrollmentRequest,
        transactionId: 'txn_pdf_err',
        orderId: 'order_pdf_err',
        webhookVerified: false,
        session: null
      });

      expect(res.status).toBe('success');
      const payment = await Payment.findOne({ transactionId: 'txn_pdf_err' });
      expect(payment).toBeTruthy();
    });
  });

  // ==========================================
  // 9. RECONCILE PAYMENTS (CRON TASK)
  // ==========================================
  describe('reconcilePayments', () => {
    it('should expire stale request when Razorpay shows order is unpaid', async () => {
      mockRazorpay.orders.fetchPayments.mockResolvedValueOnce({ items: [] });

      const staleReq = await EnrollmentRequest.create({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id,
        status: 'pending_payment',
        paymentReference: 'order_unpaid_123',
        feeSnapshot: { registrationFee: 100, joiningFee: 100, monthlyFee: 0, totalInitialCost: 200, currency: 'INR' },
        expiresAt: new Date(Date.now() - 1000) // expired
      });

      const res = await institutionsService.reconcilePayments();

      expect(res.expiredCount).toBe(1);
      expect(res.reconciledCount).toBe(0);

      const updated = await EnrollmentRequest.findById(staleReq._id);
      expect(updated.status).toBe('expired');
    });

    it('should reconcile and activate enrollment when Razorpay shows captured payment', async () => {
      mockRazorpay.orders.fetchPayments.mockResolvedValueOnce({
        items: [{ id: 'pay_captured_cron', status: 'captured', amount: 20000 }]
      });

      const staleReq = await EnrollmentRequest.create({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id,
        status: 'pending_payment',
        paymentReference: 'order_captured_123',
        feeSnapshot: { registrationFee: 100, joiningFee: 100, monthlyFee: 0, totalInitialCost: 200, currency: 'INR' },
        expiresAt: new Date(Date.now() - 1000)
      });

      const res = await institutionsService.reconcilePayments();

      expect(res.reconciledCount).toBe(1);
      expect(res.expiredCount).toBe(0);

      const updatedReq = await EnrollmentRequest.findById(staleReq._id);
      expect(updatedReq.status).toBe('completed');

      const payment = await Payment.findOne({ transactionId: 'pay_captured_cron' });
      expect(payment).toBeTruthy();
      expect(payment.paymentStatus).toBe('success');
    });

    it('should expire request if Razorpay fetchPayments throws an error', async () => {
      mockRazorpay.orders.fetchPayments.mockRejectedValueOnce(new Error('Network error'));

      const staleReq = await EnrollmentRequest.create({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id,
        status: 'pending_payment',
        paymentReference: 'order_err_123',
        feeSnapshot: { registrationFee: 100, joiningFee: 100, monthlyFee: 0, totalInitialCost: 200, currency: 'INR' },
        expiresAt: new Date(Date.now() - 1000)
      });

      const res = await institutionsService.reconcilePayments();

      expect(res.expiredCount).toBe(1);
      const updated = await EnrollmentRequest.findById(staleReq._id);
      expect(updated.status).toBe('expired');
    });
  });

  // ==========================================
  // 10. ADMIN UPDATE MEMBERSHIP
  // ==========================================
  describe('adminUpdateMembership', () => {
    let membership;

    beforeEach(async () => {
      membership = await InstitutionMembership.create({
        institutionId: defaultInstitution._id,
        userId: learnerUser._id,
        memberType: 'learner',
        status: 'active',
        paymentStatus: 'paid'
      });
    });

    it('should throw 404 MEMBERSHIP_NOT_FOUND if membership does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      await expect(
        institutionsService.adminUpdateMembership({
          membershipId: nonExistentId,
          status: 'suspended',
          adminUser: institutionAdminUser
        })
      ).rejects.toThrow('Membership not found');
    });

    it('should suspend membership and log MEMBERSHIP_SUSPENDED', async () => {
      const res = await institutionsService.adminUpdateMembership({
        membershipId: membership._id,
        status: 'suspended',
        reason: 'Policy violation',
        adminUser: institutionAdminUser,
        requestMeta: { ip: '127.0.0.1' }
      });

      expect(res.data.membership.status).toBe('suspended');
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'MEMBERSHIP_SUSPENDED',
          metadata: expect.objectContaining({ reason: 'Policy violation' })
        })
      );
    });

    it('should activate membership and log MEMBERSHIP_ACTIVATED', async () => {
      membership.status = 'pending_approval';
      await membership.save();

      const res = await institutionsService.adminUpdateMembership({
        membershipId: membership._id,
        status: 'active',
        adminUser: institutionAdminUser
      });

      expect(res.data.membership.status).toBe('active');
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'MEMBERSHIP_ACTIVATED' })
      );
    });

    it('should cancel membership, refund associated payments, and log MEMBERSHIP_CANCELLED', async () => {
      await Payment.create({
        learnerId: learnerUser._id,
        institutionId: defaultInstitution._id,
        paymentType: 'institution_enrollment',
        amount: 500,
        currency: 'INR',
        gateway: 'razorpay',
        transactionId: 'txn_refund_target',
        paymentStatus: 'success'
      });

      const res = await institutionsService.adminUpdateMembership({
        membershipId: membership._id,
        status: 'cancelled',
        reason: 'Requested withdrawal',
        adminUser: institutionAdminUser
      });

      expect(res.data.membership.status).toBe('cancelled');

      // Verify cascading payment refund
      const payment = await Payment.findOne({ transactionId: 'txn_refund_target' });
      expect(payment.paymentStatus).toBe('refunded');
      expect(payment.refundedAt).toBeTruthy();

      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'MEMBERSHIP_CANCELLED',
          metadata: expect.objectContaining({ previousStatus: 'active', nextStatus: 'cancelled' })
        })
      );
    });
  });

  // ==========================================
  // 11. MONITORING STATS
  // ==========================================
  describe('getMonitoringStats', () => {
    it('should compute conversion rate, failure rate, and average enrollment time', async () => {
      const now = Date.now();

      // 1 Completed (took 2 minutes)
      const completedReq = await EnrollmentRequest.create({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id,
        status: 'completed',
        feeSnapshot: { registrationFee: 100, joiningFee: 100, monthlyFee: 0, totalInitialCost: 200, currency: 'INR' },
        expiresAt: new Date(now + 10000)
      });
      await EnrollmentRequest.collection.updateOne(
        { _id: completedReq._id },
        { $set: { createdAt: new Date(now - 2 * 60 * 1000), updatedAt: new Date(now) } }
      );

      // 1 Failed
      await EnrollmentRequest.create({
        userId: otherLearnerUser._id,
        institutionId: defaultInstitution._id,
        status: 'failed',
        feeSnapshot: { registrationFee: 100, joiningFee: 100, monthlyFee: 0, totalInitialCost: 200, currency: 'INR' },
        expiresAt: new Date(now + 10000)
      });

      const stats = await institutionsService.getMonitoringStats();

      expect(stats.totalRequests).toBe(2);
      expect(stats.completedRequests).toBe(1);
      expect(stats.failedRequests).toBe(1);
      expect(stats.conversionRatePercentage).toBe(50);
      expect(stats.failureRatePercentage).toBe(50);
      expect(stats.averageEnrollmentTimeMinutes).toBeCloseTo(2, 0);
    });

    it('should return 0% conversion, 0% failure rate, and 0 avg minutes when totalRequests=0', async () => {
      const stats = await institutionsService.getMonitoringStats();
      expect(stats.totalRequests).toBe(0);
      expect(stats.conversionRatePercentage).toBe(0);
      expect(stats.failureRatePercentage).toBe(0);
      expect(stats.averageEnrollmentTimeMinutes).toBe(0);
    });
  });

  // ==========================================
  // 12. HANDLE PAYMENT FAILURE & FRAUD ALERT
  // ==========================================
  describe('handlePaymentFailureForEnrollment', () => {
    let enrollmentRequest;

    beforeEach(async () => {
      enrollmentRequest = await EnrollmentRequest.create({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id,
        status: 'pending_payment',
        feeSnapshot: { registrationFee: 100, joiningFee: 100, monthlyFee: 0, totalInitialCost: 200, currency: 'INR' },
        expiresAt: new Date(Date.now() + 10000)
      });
    });

    it('should mark request as failed and log PAYMENT_FAILED audit action', async () => {
      await institutionsService.handlePaymentFailureForEnrollment({
        enrollmentRequest,
        transactionId: 'txn_fail_1'
      });

      const updated = await EnrollmentRequest.findById(enrollmentRequest._id);
      expect(updated.status).toBe('failed');

      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PAYMENT_FAILED',
          metadata: expect.objectContaining({ transactionId: 'txn_fail_1' })
        })
      );
      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Payment Failed' })
      );
    });

    it('should trigger FRAUD_ALERT when >= 3 failures occur in 1 hour for same user and institution', async () => {
      // Create 2 earlier failed requests in the past 10 minutes
      await EnrollmentRequest.create([
        {
          userId: learnerUser._id,
          institutionId: defaultInstitution._id,
          status: 'failed',
          feeSnapshot: { registrationFee: 100, joiningFee: 100, monthlyFee: 0, totalInitialCost: 200, currency: 'INR' },
          expiresAt: new Date(),
          updatedAt: new Date(Date.now() - 5 * 60 * 1000)
        },
        {
          userId: learnerUser._id,
          institutionId: defaultInstitution._id,
          status: 'failed',
          feeSnapshot: { registrationFee: 100, joiningFee: 100, monthlyFee: 0, totalInitialCost: 200, currency: 'INR' },
          expiresAt: new Date(),
          updatedAt: new Date(Date.now() - 2 * 60 * 1000)
        }
      ]);

      // Now fail this 3rd request
      await institutionsService.handlePaymentFailureForEnrollment({
        enrollmentRequest,
        transactionId: 'txn_fail_3_fraud'
      });

      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'FRAUD_ALERT',
          metadata: expect.objectContaining({
            recentFailureCount: 3,
            window: '1_hour'
          })
        })
      );

      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ title: '⚠ Fraud Alert' })
      );
    });

    it('should not trigger FRAUD_ALERT if failure count is less than 3', async () => {
      await institutionsService.handlePaymentFailureForEnrollment({
        enrollmentRequest,
        transactionId: 'txn_fail_single'
      });

      expect(auditService.logAdminAction).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'FRAUD_ALERT' })
      );
    });
  });

  // ==========================================
  // 13. GET PAYMENT HISTORY (LEARNER)
  // ==========================================
  describe('getPaymentHistory', () => {
    it('should return paginated payment history for the learner only', async () => {
      await Payment.create([
        {
          learnerId: learnerUser._id,
          institutionId: defaultInstitution._id,
          paymentType: 'institution_enrollment',
          amount: 300,
          currency: 'INR',
          gateway: 'razorpay',
          transactionId: 'txn_hist_1',
          paymentStatus: 'success'
        },
        {
          learnerId: learnerUser._id,
          institutionId: defaultInstitution._id,
          paymentType: 'institution_enrollment',
          amount: 400,
          currency: 'INR',
          gateway: 'razorpay',
          transactionId: 'txn_hist_2',
          paymentStatus: 'success'
        },
        {
          learnerId: otherLearnerUser._id, // Other user's payment
          institutionId: defaultInstitution._id,
          paymentType: 'institution_enrollment',
          amount: 500,
          currency: 'INR',
          gateway: 'razorpay',
          transactionId: 'txn_hist_other',
          paymentStatus: 'success'
        }
      ]);

      const res = await institutionsService.getPaymentHistory({
        userId: learnerUser._id,
        page: 1,
        limit: 10
      });

      expect(res.payments).toHaveLength(2);
      expect(res.pagination.total).toBe(2);
      expect(res.payments[0].institutionId.name).toBe('Apex Academy');
    });
  });

  // ==========================================
  // 14. GET INSTITUTION PAYMENT RECORDS (ADMIN MULTI-TENANCY)
  // ==========================================
  describe('getInstitutionPaymentRecords - Multi-Tenant Security', () => {
    it('should allow institution_admin to view records for their own institution', async () => {
      await Payment.create({
        learnerId: learnerUser._id,
        institutionId: defaultInstitution._id,
        paymentType: 'institution_enrollment',
        amount: 250,
        currency: 'INR',
        gateway: 'razorpay',
        transactionId: 'txn_rec_1',
        paymentStatus: 'success'
      });

      const res = await institutionsService.getInstitutionPaymentRecords({
        adminUser: institutionAdminUser,
        institutionId: defaultInstitution._id
      });

      expect(res.payments).toHaveLength(1);
      expect(res.pagination.total).toBe(1);
      expect(res.payments[0].learnerId.name).toBe('Learner User');
    });

    it('should throw 403 FORBIDDEN if institution_admin attempts to view records of another institution', async () => {
      await expect(
        institutionsService.getInstitutionPaymentRecords({
          adminUser: institutionAdminUser,
          institutionId: otherInstitution._id // Attempting cross-tenant access
        })
      ).rejects.toThrow('Access denied: you can only view your own institution records');
    });

    it('should allow platform_admin to view payment records of any institution', async () => {
      await Payment.create({
        learnerId: learnerUser._id,
        institutionId: otherInstitution._id,
        paymentType: 'institution_enrollment',
        amount: 350,
        currency: 'INR',
        gateway: 'razorpay',
        transactionId: 'txn_rec_platform',
        paymentStatus: 'success'
      });

      const res = await institutionsService.getInstitutionPaymentRecords({
        adminUser: platformAdminUser,
        institutionId: otherInstitution._id
      });

      expect(res.payments).toHaveLength(1);
      expect(res.pagination.total).toBe(1);
    });
  });

  // ==========================================
  // 15. GET PAYMENT REVENUE REPORT
  // ==========================================
  describe('getPaymentRevenueReport', () => {
    it('should aggregate revenue and rates for institution_admin scoped to own institution', async () => {
      // Success payments for defaultInstitution
      await Payment.create([
        {
          learnerId: learnerUser._id,
          institutionId: defaultInstitution._id,
          paymentType: 'institution_enrollment',
          amount: 500,
          currency: 'INR',
          gateway: 'razorpay',
          transactionId: 'txn_rev_1',
          paymentStatus: 'success'
        },
        {
          learnerId: otherLearnerUser._id,
          institutionId: defaultInstitution._id,
          paymentType: 'institution_enrollment',
          amount: 500,
          currency: 'INR',
          gateway: 'razorpay',
          transactionId: 'txn_rev_2',
          paymentStatus: 'success'
        },
        {
          learnerId: otherLearnerUser._id,
          institutionId: otherInstitution._id, // Other institution's revenue
          paymentType: 'institution_enrollment',
          amount: 1000,
          currency: 'INR',
          gateway: 'razorpay',
          transactionId: 'txn_rev_other',
          paymentStatus: 'success'
        }
      ]);

      // 1 Failed request
      await EnrollmentRequest.create({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id,
        status: 'failed',
        feeSnapshot: { registrationFee: 100, joiningFee: 100, monthlyFee: 0, totalInitialCost: 200, currency: 'INR' },
        expiresAt: new Date()
      });

      const report = await institutionsService.getPaymentRevenueReport({
        adminUser: institutionAdminUser
      });

      expect(report.totalRevenue).toBe(1000);
      expect(report.successCount).toBe(2);
      expect(report.failedCount).toBe(1);
      expect(report.successRatePercent).toBe('66.67');
      expect(report.failureRatePercent).toBe('33.33');
    });

    it('should aggregate revenue across all institutions for platform_admin when no institutionId is passed', async () => {
      await Payment.create([
        {
          learnerId: learnerUser._id,
          institutionId: defaultInstitution._id,
          paymentType: 'institution_enrollment',
          amount: 300,
          currency: 'INR',
          gateway: 'razorpay',
          transactionId: 'txn_rev_all_1',
          paymentStatus: 'success'
        },
        {
          learnerId: otherLearnerUser._id,
          institutionId: otherInstitution._id,
          paymentType: 'institution_enrollment',
          amount: 700,
          currency: 'INR',
          gateway: 'razorpay',
          transactionId: 'txn_rev_all_2',
          paymentStatus: 'success'
        }
      ]);

      const report = await institutionsService.getPaymentRevenueReport({
        adminUser: platformAdminUser
      });

      expect(report.totalRevenue).toBe(1000);
      expect(report.successCount).toBe(2);
      expect(report.successRatePercent).toBe('100.00');
    });

    it('should aggregate revenue for platform_admin with a specific institutionId', async () => {
      const report = await institutionsService.getPaymentRevenueReport({
        adminUser: platformAdminUser,
        institutionId: defaultInstitution._id
      });

      expect(report.totalRevenue).toBe(0);
      expect(report.successCount).toBe(0);
      expect(report.successRatePercent).toBe('0.00');
    });

    it('should handle zero attempts gracefully with 0.00 rates', async () => {
      const report = await institutionsService.getPaymentRevenueReport({
        adminUser: platformAdminUser
      });

      expect(report.totalRevenue).toBe(0);
      expect(report.successCount).toBe(0);
      expect(report.successRatePercent).toBe('0.00');
      expect(report.failureRatePercent).toBe('0.00');
    });
  });

  // ==========================================
  // 16. DOWNLOAD INSTITUTION INVOICE
  // ==========================================
  describe('downloadInstitutionInvoice', () => {
    let payment;
    let enrollmentRequest;

    beforeEach(async () => {
      enrollmentRequest = await EnrollmentRequest.create({
        userId: learnerUser._id,
        institutionId: defaultInstitution._id,
        status: 'completed',
        feeSnapshot: { registrationFee: 100, joiningFee: 100, monthlyFee: 0, totalInitialCost: 200, currency: 'INR' },
        expiresAt: new Date()
      });

      payment = await Payment.create({
        learnerId: learnerUser._id,
        institutionId: defaultInstitution._id,
        enrollmentRequestId: enrollmentRequest._id,
        paymentType: 'institution_enrollment',
        amount: 200,
        currency: 'INR',
        gateway: 'razorpay',
        transactionId: 'txn_inv_dl',
        paymentStatus: 'success'
      });
    });

    it('should generate and return invoice PDF buffer for the learner', async () => {
      const res = await institutionsService.downloadInstitutionInvoice({
        paymentId: payment._id,
        userId: learnerUser._id
      });

      expect(res.transactionId).toBe('txn_inv_dl');
      expect(Buffer.isBuffer(res.buffer)).toBe(true);
      expect(mockPdfUtil.generateInstitutionInvoicePdf).toHaveBeenCalledWith(
        expect.objectContaining({ transactionId: 'txn_inv_dl' }),
        expect.objectContaining({ name: 'Apex Academy' }),
        expect.objectContaining({ status: 'completed' }),
        expect.objectContaining({ email: 'learner@test.com' })
      );
    });

    it('should throw 404 INVOICE_NOT_FOUND if payment belongs to a different learner (IDOR check)', async () => {
      await expect(
        institutionsService.downloadInstitutionInvoice({
          paymentId: payment._id,
          userId: otherLearnerUser._id // IDOR attempt
        })
      ).rejects.toThrow('Invoice not found or payment not completed');
    });

    it('should throw 404 if payment is not marked success', async () => {
      payment.paymentStatus = 'failed';
      await payment.save();

      await expect(
        institutionsService.downloadInstitutionInvoice({
          paymentId: payment._id,
          userId: learnerUser._id
        })
      ).rejects.toThrow('Invoice not found or payment not completed');
    });
  });
});
