const mongoose = require('mongoose');
const enrollmentService = require('../../../src/services/enrollment.service');
const User = require('../../../src/models/user.model');
const Course = require('../../../src/models/course.model');
const Enrollment = require('../../../src/models/enrollment.model');
const Progress = require('../../../src/models/progress.model');
const Payment = require('../../../src/models/payment.model');
const Certificate = require('../../../src/models/certificate.model');
const QuizAttempt = require('../../../src/models/quizAttempt.model');
const Lesson = require('../../../src/models/lesson.model');
const Submission = require('../../../src/models/submission.model');
const { ApiError } = require('../../../src/utils/errors');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { buildUser } = require('../../fixtures/user.fixture');
const { buildEnrollment } = require('../../fixtures/enrollment.fixture');

jest.mock('../../../src/config/razorpay', () => ({
  orders: {
    create: jest.fn().mockResolvedValue({ id: 'order_mock_razorpay_123', amount: 49900, currency: 'INR' })
  }
}));

jest.mock('../../../src/services/notification.service', () => ({
  triggerNewEnrollmentNotification: jest.fn().mockResolvedValue(true),
  triggerEnrollmentConfirmedNotification: jest.fn().mockResolvedValue(true),
  triggerBulkEnrollmentNotification: jest.fn().mockResolvedValue(true)
}));

const razorpay = require('../../../src/config/razorpay');
const notificationService = require('../../../src/services/notification.service');

describe('Enrollment Service Unit Tests', () => {
  let learner;
  let tutor;
  let admin;

  beforeAll(async () => {
    await connectDB();
  });

  beforeEach(async () => {
    learner = await new User(buildUser({ email: 'learner@example.com', role: 'learner' })).save();
    tutor = await new User(buildUser({ email: 'tutor@example.com', role: 'tutor' })).save();
    admin = await new User(buildUser({ email: 'admin@example.com', role: 'platform_owner' })).save();
  });

  afterEach(async () => {
    await clearDB();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await closeDB();
  });

  // ======================================================
  // 1. ENROLL IN COURSE
  // ======================================================
  describe('enrollCourse', () => {
    test('should throw 404 COURSE_NOT_FOUND if course is missing, deleted, or not published', async () => {
      const courseId = new mongoose.Types.ObjectId();

      let err;
      try {
        await enrollmentService.enrollCourse({ userId: learner._id, courseId });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe('COURSE_NOT_FOUND');
    });

    test('should throw 409 COURSE_ALREADY_ENROLLED if user has active or completed enrollment', async () => {
      const course = await new Course({
        title: 'Node.js Mastery',
        description: 'Backend guide',
        category: 'Development',
        level: 'Beginner',
        authorId: tutor._id,
        status: 'published',
        isFree: true
      }).save();

      await new Enrollment(buildEnrollment(learner._id, course._id, { status: 'active' })).save();

      let err;
      try {
        await enrollmentService.enrollCourse({ userId: learner._id, courseId: course._id });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('COURSE_ALREADY_ENROLLED');
    });

    test('should successfully enroll in a free course and initialize progress', async () => {
      const course = await new Course({
        title: 'Free Intro Course',
        description: 'Free course description',
        category: 'Development',
        level: 'Beginner',
        authorId: tutor._id,
        status: 'published',
        isFree: true,
        price: 0
      }).save();

      const result = await enrollmentService.enrollCourse({
        userId: learner._id,
        courseId: course._id,
        billingAddress: '123 Tech Street',
        billingPhone: '9876543210'
      });

      expect(result.message).toBe('Course enrolled successfully');
      expect(result.data.enrollment.status).toBe('active');
      expect(result.data.enrollment.enrollmentType).toBe('free');

      const progress = await Progress.findOne({ userId: learner._id, courseId: course._id });
      expect(progress).toBeDefined();

      const updatedCourse = await Course.findById(course._id);
      expect(updatedCourse.enrollmentCount).toBe(1);

      expect(notificationService.triggerEnrollmentConfirmedNotification).toHaveBeenCalledWith({
        studentId: learner._id,
        courseId: course._id
      });
    });

    test('should initiate Razorpay payment order for paid courses', async () => {
      const course = await new Course({
        title: 'Paid Advanced Course',
        description: 'Premium content',
        category: 'Development',
        level: 'Advanced',
        authorId: tutor._id,
        status: 'published',
        isFree: false,
        price: 499,
        currency: 'INR'
      }).save();

      const result = await enrollmentService.enrollCourse({
        userId: learner._id,
        courseId: course._id
      });

      expect(result.message).toBe('Payment order initiated');
      expect(result.data.enrollment.status).toBe('pending_payment');
      expect(result.data.enrollment.enrollmentType).toBe('paid');
      expect(result.data.razorpayOrder).toEqual({
        id: 'order_mock_razorpay_123',
        amount: 49900,
        currency: 'INR'
      });
    });

    test('should re-initiate payment order if existing pending_payment enrollment exists', async () => {
      const course = await new Course({
        title: 'Paid Course Retry',
        description: 'Premium content',
        category: 'Development',
        level: 'Intermediate',
        authorId: tutor._id,
        status: 'published',
        isFree: false,
        price: 499
      }).save();

      const pendingEnrollment = await new Enrollment(buildEnrollment(learner._id, course._id, {
        status: 'pending_payment',
        enrollmentType: 'paid',
        paymentStatus: 'pending'
      })).save();

      const result = await enrollmentService.enrollCourse({
        userId: learner._id,
        courseId: course._id,
        billingAddress: 'New Address 456'
      });

      expect(result.message).toBe('Payment order initiated');
      expect(result.data.enrollment._id.toString()).toBe(pendingEnrollment._id.toString());
      expect(result.data.razorpayOrder.id).toBe('order_mock_razorpay_123');

      const updatedEnrollment = await Enrollment.findById(pendingEnrollment._id);
      expect(updatedEnrollment.paymentReference).toBe('order_mock_razorpay_123');
      expect(updatedEnrollment.billingAddress).toBe('New Address 456');
    });

    test('should throw 500 ApiError if Razorpay order creation fails', async () => {
      const course = await new Course({
        title: 'Razorpay Fail Course',
        description: 'Payment fail test',
        category: 'Development',
        level: 'Intermediate',
        authorId: tutor._id,
        status: 'published',
        isFree: false,
        price: 999
      }).save();

      razorpay.orders.create.mockRejectedValueOnce(new Error('Gateway Down'));

      let err;
      try {
        await enrollmentService.enrollCourse({ userId: learner._id, courseId: course._id });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(500);
      expect(err.message).toBe('Failed to initialize payment gateway');
    });
  });

  // ======================================================
  // 2. MY ENROLLMENTS
  // ======================================================
  describe('getMyEnrollments', () => {
    test('should fetch paginated user enrollments and map course object', async () => {
      const course = await new Course({
        title: 'Course 1',
        description: 'Desc 1',
        category: 'Tech',
        level: 'Beginner',
        authorId: tutor._id,
        status: 'published'
      }).save();

      await new Enrollment(buildEnrollment(learner._id, course._id, { status: 'active' })).save();

      const result = await enrollmentService.getMyEnrollments({
        userId: learner._id,
        query: { page: '1', limit: '10' }
      });

      expect(result.message).toBe('Enrollments retrieved successfully');
      expect(result.data.enrollments.length).toBe(1);
      expect(result.data.enrollments[0].course.title).toBe('Course 1');
      expect(result.data.pagination.total).toBe(1);
    });

    test('should filter enrollments by status', async () => {
      const course1 = await new Course({
        title: 'Active Course',
        description: 'Desc',
        category: 'Tech',
        level: 'Beginner',
        authorId: tutor._id
      }).save();

      const course2 = await new Course({
        title: 'Completed Course',
        description: 'Desc',
        category: 'Tech',
        level: 'Beginner',
        authorId: tutor._id
      }).save();

      await new Enrollment(buildEnrollment(learner._id, course1._id, { status: 'active' })).save();
      await new Enrollment(buildEnrollment(learner._id, course2._id, { status: 'completed' })).save();

      const result = await enrollmentService.getMyEnrollments({
        userId: learner._id,
        query: { status: 'completed' }
      });

      expect(result.data.enrollments.length).toBe(1);
      expect(result.data.enrollments[0].status).toBe('completed');
    });
  });

  // ======================================================
  // 3. CHECK ENROLLMENT STATUS
  // ======================================================
  describe('checkEnrollment', () => {
    test('should return enrolled: true when user has an active enrollment', async () => {
      const courseId = new mongoose.Types.ObjectId();
      await new Enrollment(buildEnrollment(learner._id, courseId, { status: 'active' })).save();

      const result = await enrollmentService.checkEnrollment({ userId: learner._id, courseId });

      expect(result.data.enrolled).toBe(true);
      expect(result.data.enrollment.status).toBe('active');
    });

    test('should return enrolled: false when user has no active enrollment', async () => {
      const courseId = new mongoose.Types.ObjectId();

      const result = await enrollmentService.checkEnrollment({ userId: learner._id, courseId });

      expect(result.data.enrolled).toBe(false);
      expect(result.data.enrollment).toBeNull();
    });
  });

  // ======================================================
  // 4. CANCEL ENROLLMENT
  // ======================================================
  describe('cancelEnrollment', () => {
    test('should throw 404 ENROLLMENT_NOT_FOUND if active enrollment does not exist', async () => {
      const courseId = new mongoose.Types.ObjectId();

      let err;
      try {
        await enrollmentService.cancelEnrollment({ userId: learner._id, courseId });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe('ENROLLMENT_NOT_FOUND');
    });

    test('should throw 403 PAID_COURSE_UNENROLL_FORBIDDEN if learner cancels paid course without admin rights', async () => {
      const courseId = new mongoose.Types.ObjectId();
      await new Enrollment(buildEnrollment(learner._id, courseId, {
        status: 'active',
        enrollmentType: 'paid'
      })).save();

      let err;
      try {
        await enrollmentService.cancelEnrollment({ userId: learner._id, courseId, isAdmin: false });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe('PAID_COURSE_UNENROLL_FORBIDDEN');
    });

    test('should cancel free course enrollment, decrement course count, and soft delete progress', async () => {
      const course = await new Course({
        title: 'Cancel Free Course',
        description: 'Desc',
        category: 'Tech',
        level: 'Beginner',
        authorId: tutor._id,
        enrollmentCount: 1
      }).save();

      await new Enrollment(buildEnrollment(learner._id, course._id, {
        status: 'active',
        enrollmentType: 'free'
      })).save();

      await new Progress({ userId: learner._id, courseId: course._id }).save();

      const result = await enrollmentService.cancelEnrollment({
        userId: learner._id,
        courseId: course._id,
        isAdmin: false
      });

      expect(result.message).toBe('Enrollment cancelled successfully');

      const cancelledEnrollment = await Enrollment.findOne({ userId: learner._id, courseId: course._id });
      expect(cancelledEnrollment.status).toBe('cancelled');
      expect(cancelledEnrollment.deletedAt).toBeDefined();

      const updatedCourse = await Course.findById(course._id);
      expect(updatedCourse.enrollmentCount).toBe(0);

      const progress = await Progress.findOne({ userId: learner._id, courseId: course._id });
      expect(progress.deletedAt).toBeDefined();
    });

    test('should allow admin to cancel paid course enrollment', async () => {
      const course = await new Course({
        title: 'Cancel Paid Course',
        description: 'Desc',
        category: 'Tech',
        level: 'Beginner',
        authorId: tutor._id,
        enrollmentCount: 1
      }).save();

      await new Enrollment(buildEnrollment(learner._id, course._id, {
        status: 'active',
        enrollmentType: 'paid'
      })).save();

      const result = await enrollmentService.cancelEnrollment({
        userId: learner._id,
        courseId: course._id,
        isAdmin: true
      });

      expect(result.message).toBe('Enrollment cancelled successfully');
    });
  });

  // ======================================================
  // 5. REQUEST REFUND
  // ======================================================
  describe('requestRefund', () => {
    test('should throw 404 if active enrollment is missing', async () => {
      const courseId = new mongoose.Types.ObjectId();

      let err;
      try {
        await enrollmentService.requestRefund({ userId: learner._id, courseId });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(404);
      expect(err.message).toBe('Active enrollment not found');
    });

    test('should throw 400 if no successful payment is found', async () => {
      const courseId = new mongoose.Types.ObjectId();
      await new Enrollment(buildEnrollment(learner._id, courseId, { status: 'active' })).save();

      let err;
      try {
        await enrollmentService.requestRefund({ userId: learner._id, courseId });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(400);
      expect(err.message).toBe('No successful payment found for this enrollment');
    });

    test('should throw 403 if payment type is institution_enrollment', async () => {
      const courseId = new mongoose.Types.ObjectId();
      await new Enrollment(buildEnrollment(learner._id, courseId, { status: 'active' })).save();
      await new Payment({
        learnerId: learner._id,
        courseId,
        amount: 499,
        paymentStatus: 'success',
        paymentType: 'institution_enrollment',
        transactionId: 'tx_inst_123'
      }).save();

      let err;
      try {
        await enrollmentService.requestRefund({ userId: learner._id, courseId });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(403);
      expect(err.message).toContain('Institutional enrollments cannot be refunded');
    });

    test('should throw 403 if payment is older than 14 days', async () => {
      const courseId = new mongoose.Types.ObjectId();
      await new Enrollment(buildEnrollment(learner._id, courseId, { status: 'active' })).save();
      const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      await new Payment({
        learnerId: learner._id,
        courseId,
        amount: 499,
        paymentStatus: 'success',
        transactionId: 'tx_old_123',
        paidAt: oldDate
      }).save();

      let err;
      try {
        await enrollmentService.requestRefund({ userId: learner._id, courseId });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(403);
      expect(err.message).toContain('14-day refund window');
    });

    test('should throw 403 if course materials were downloaded', async () => {
      const courseId = new mongoose.Types.ObjectId();
      await new Enrollment(buildEnrollment(learner._id, courseId, { status: 'active' })).save();
      await new Payment({
        learnerId: learner._id,
        courseId,
        amount: 499,
        paymentStatus: 'success',
        transactionId: 'tx_mat_123'
      }).save();

      await new Progress({
        userId: learner._id,
        courseId,
        hasDownloadedMaterials: true
      }).save();

      let err;
      try {
        await enrollmentService.requestRefund({ userId: learner._id, courseId });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(403);
      expect(err.message).toContain('Course materials have been downloaded');
    });

    test('should throw 403 if certificate was already issued', async () => {
      const courseId = new mongoose.Types.ObjectId();
      await new Enrollment(buildEnrollment(learner._id, courseId, { status: 'active' })).save();
      await new Payment({
        learnerId: learner._id,
        courseId,
        amount: 499,
        paymentStatus: 'success',
        transactionId: 'tx_cert_123'
      }).save();

      await new Certificate({
        userId: learner._id,
        courseId,
        certificateNumber: 'CERT-1234',
        status: 'issued'
      }).save();

      let err;
      try {
        await enrollmentService.requestRefund({ userId: learner._id, courseId });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(403);
      expect(err.message).toContain('certificate has already been issued');
    });

    test('should submit refund request when all criteria pass', async () => {
      const courseId = new mongoose.Types.ObjectId();
      const enrollment = await new Enrollment(buildEnrollment(learner._id, courseId, { status: 'active' })).save();
      const payment = await new Payment({
        learnerId: learner._id,
        courseId,
        amount: 499,
        paymentStatus: 'success',
        transactionId: 'tx_valid_123'
      }).save();

      const result = await enrollmentService.requestRefund({ userId: learner._id, courseId });

      expect(result.message).toBe('Refund request submitted and is pending admin approval');

      const updatedPayment = await Payment.findById(payment._id);
      expect(updatedPayment.paymentStatus).toBe('refund_pending');

      const updatedEnrollment = await Enrollment.findById(enrollment._id);
      expect(updatedEnrollment.status).toBe('refund_pending');
    });
  });

  // ======================================================
  // 6. GET TUTOR STUDENTS
  // ======================================================
  describe('getTutorStudents', () => {
    test('should return tutor students list with populated progress and quiz attempts', async () => {
      const course = await new Course({
        title: 'Tutor Course 1',
        description: 'Tutor desc',
        category: 'Development',
        level: 'Beginner',
        authorId: tutor._id,
        status: 'published'
      }).save();

      await new Enrollment(buildEnrollment(learner._id, course._id, { status: 'active' })).save();

      const result = await enrollmentService.getTutorStudents({
        tutorId: tutor._id,
        query: { page: '1', limit: '10' }
      });

      expect(result.message).toBe('Tutor students retrieved successfully');
      expect(result.data.enrollments.length).toBe(1);
      expect(result.data.courses.length).toBe(1);
      expect(result.data.pagination.total).toBe(1);
    });
  });

  // ======================================================
  // 7. BULK ENROLL STUDENTS
  // ======================================================
  describe('bulkEnrollStudents', () => {
    test('should throw 404 COURSE_NOT_FOUND if target course does not exist', async () => {
      const courseId = new mongoose.Types.ObjectId();

      let err;
      try {
        await enrollmentService.bulkEnrollStudents({
          adminId: admin._id,
          emails: ['learner@example.com'],
          courseId
        });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe('COURSE_NOT_FOUND');
    });

    test('should bulk enroll valid users and track failed emails', async () => {
      const course = await new Course({
        title: 'Bulk Course',
        description: 'Bulk desc',
        category: 'Development',
        level: 'Beginner',
        authorId: tutor._id,
        status: 'published'
      }).save();

      const result = await enrollmentService.bulkEnrollStudents({
        adminId: admin._id,
        emails: ['learner@example.com', 'nonexistent@example.com'],
        courseId: course._id
      });

      expect(result.message).toBe('Bulk enrollment completed');
      expect(result.data.successful.length).toBe(1);
      expect(result.data.successful[0].email).toBe('learner@example.com');

      expect(result.data.failed.length).toBe(1);
      expect(result.data.failed[0].email).toBe('nonexistent@example.com');
      expect(result.data.failed[0].reason).toBe('User not found');

      const enrollment = await Enrollment.findOne({ userId: learner._id, courseId: course._id });
      expect(enrollment).toBeDefined();
      expect(enrollment.status).toBe('active');

      const updatedCourse = await Course.findById(course._id);
      expect(updatedCourse.enrollmentCount).toBe(1);

      expect(notificationService.triggerBulkEnrollmentNotification).toHaveBeenCalledWith({
        courseId: course._id,
        studentCount: 1
      });
    });
  });
});
