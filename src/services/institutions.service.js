const mongoose = require('mongoose');
const Institution = require('../models/institution.model');
const InstitutionMembership = require('../models/institutionMembership.model');
const InstitutionFeePlan = require('../models/institutionFeePlan.model');
const EnrollmentRequest = require('../models/enrollmentRequest.model');
const Payment = require('../models/payment.model');
const User = require('../models/user.model');
const Course = require('../models/course.model');
const { ApiError } = require('../utils/errors');
const auditService = require('./audit.service');
const emailService = require('./email.service');
const notificationService = require('./notification.service');
const razorpay = require('../config/razorpay');
const crypto = require('crypto');
const env = require('../config/env');
const { generateInstitutionInvoicePdf } = require('../utils/pdf.util');
const { isInstitutionAdminRole } = require('../utils/roles');

// Capacity warning threshold (80%)
const CAPACITY_WARNING_THRESHOLD = 0.80;

const runInTransaction = async (fn) => {
  let session = null;
  try {
    session = await mongoose.startSession();
    session.startTransaction();
  } catch (sessionErr) {
    console.warn('[MongoDB Session] Transactions not supported by environment. Falling back to atomic mode.');
    session = null;
  }

  try {
    const result = await fn(session);
    if (session) {
      await session.commitTransaction();
    }
    return result;
  } catch (err) {
    if (session && session.inTransaction()) {
      await session.abortTransaction();
    }
    throw err;
  } finally {
    if (session) {
      session.endSession();
    }
  }
};

const notifyInstitutionAdminsOfEnrollment = async ({ institutionId, learner, institutionName, membershipId }) => {
  try {
    const adminUsers = await User.find({
      role: { $in: ['platform_admin', 'super_admin', 'platform_owner'] },
      deletedAt: null
    }).select('_id').lean();

    const uniqueAdminIds = [...new Set(adminUsers.map((admin) => String(admin._id)))];
    for (const adminId of uniqueAdminIds) {
      await notificationService.createNotification({
        userId: adminId,
        title: 'New Institution Enrollment',
        message: `${learner.name || 'A learner'} enrolled in "${institutionName}".`,
        type: 'system',
        metadata: {
          institutionId,
          learnerId: learner._id,
          membershipId
        }
      });
    }
  } catch (err) {
    console.error('[Notification] Institution admin enrollment notification failed:', err.message);
  }
};

/**
 * Searches published, active, and acceptsEnrollments institutions
 */
const search = async ({ keyword, page = 1, limit = 20, sort = 'newest', user, requestMeta }) => {
  const filter = {
    status: 'active',
    isPublished: true,
    acceptsEnrollments: true
  };

  if (keyword) {
    filter.$or = [
      { name: { $regex: keyword, $options: 'i' } },
      { description: { $regex: keyword, $options: 'i' } }
    ];
  }

  const sortOrder = sort === 'name' ? { name: 1 } : { createdAt: -1 };
  const skip = (page - 1) * limit;

  const [institutions, total] = await Promise.all([
    Institution.find(filter)
      .sort(sortOrder)
      .skip(skip)
      .limit(limit)
      .lean(),
    Institution.countDocuments(filter)
  ]);

  // Log Search Action
  if (user) {
    await auditService.logAdminAction({
      actorUserId: user._id,
      targetUserId: user._id,
      action: 'INSTITUTION_SEARCH',
      metadata: { keyword, page, limit, resultsCount: institutions.length },
      requestMeta
    });
  }

  return {
    institutions,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit)
    }
  };
};

/**
 * Retrieves full profile of an institution including active fee structures
 */
const getDetail = async ({ institutionId }) => {
  const inst = await Institution.findOne({
    _id: institutionId,
    status: 'active',
    isPublished: true
  }).lean();

  if (!inst) {
    throw new ApiError(404, 'Institution not found or unavailable', 'INSTITUTION_NOT_AVAILABLE');
  }

  const feePlan = await InstitutionFeePlan.findOne({
    institutionId,
    active: true
  }).lean();

  const [learnerCount, institutionAuthorIds] = await Promise.all([
    InstitutionMembership.countDocuments({
      institutionId,
      status: 'active',
      memberType: 'learner'
    }),
    User.find({
      institutionId,
      role: { $in: ['tutor', 'institution_admin', 'admin'] },
      status: 'active',
      deletedAt: null
    }).distinct('_id')
  ]);

  const courses = await Course.find({
    authorId: { $in: institutionAuthorIds },
    status: 'published',
    visibility: 'public',
    deletedAt: null
  })
    .select('title shortDescription category level thumbnailUrl price currency isFree durationInMinutes totalLessons averageRating reviewCount')
    .sort({ publishedAt: -1, createdAt: -1 })
    .limit(20)
    .lean();

  return {
    institution: {
      ...inst,
      metadata: {
        ...inst.metadata,
        learnerCount
      }
    },
    courses,
    feePlan: feePlan || {
      registrationFee: 0,
      joiningFee: 0,
      monthlyFee: 0,
      paymentRequired: false,
      currency: 'INR'
    }
  };
};

/**
 * Initiates enrollment into an institution
 */
const enroll = async ({ userId, institutionId, idempotencyKey, requestMeta }) => {
  const user = await User.findOne({ _id: userId, deletedAt: null });
  if (!user) throw new ApiError(404, 'User not found', 'USER_NOT_FOUND');
  if (['suspended', 'blocked', 'banned'].includes(user.status)) {
    throw new ApiError(403, 'Account is suspended or blocked', 'ACCOUNT_NOT_ACTIVE');
  }

  const detail = await getDetail({ institutionId });
  const inst = detail.institution;
  const feePlan = detail.feePlan;

  if (inst.acceptsEnrollments !== true) {
    throw new ApiError(400, 'Institution is not accepting enrollments at this time', 'INSTITUTION_NOT_AVAILABLE');
  }

  // Enforce Capacity Gating
  if (inst.enrollmentCapacity !== null && inst.enrollmentCapacity !== undefined) {
    if (inst.metadata.learnerCount >= inst.enrollmentCapacity) {
      throw new ApiError(400, 'Institution enrollment capacity is full', 'INSTITUTION_CAPACITY_FULL');
    }
  }

  // Duplicate Membership Protection
  const existingMembership = await InstitutionMembership.findOne({
    institutionId,
    userId
  });

  if (existingMembership) {
    if (['active', 'pending_payment', 'pending_approval'].includes(existingMembership.status)) {
      throw new ApiError(409, 'Already enrolled or enrollment request is pending', 'ALREADY_ENROLLED');
    }
  }

  // Self-Enrolled Tutor Protection
  if (user.role === 'tutor' && String(user.institutionId) !== String(institutionId)) {
    throw new ApiError(403, 'Tutors can only enroll into their designated institution', 'UNAUTHORIZED_ENROLLMENT');
  }

  // Log Enrollment Initiated
  await auditService.logAdminAction({
    actorUserId: userId,
    targetUserId: userId,
    action: 'ENROLLMENT_INITIATED',
    metadata: { institutionId, idempotencyKey },
    requestMeta
  });

  // Scenario A: Free Enrollment
  if (!feePlan.paymentRequired || (feePlan.registrationFee === 0 && feePlan.joiningFee === 0)) {
    return await runInTransaction(async (session) => {
      // Atomic Gating: check and increment learnerCount atomically
      const atomicInst = await Institution.findOneAndUpdate(
        {
          _id: institutionId,
          status: 'active',
          isPublished: true,
          acceptsEnrollments: true,
          $or: [
            { enrollmentCapacity: null },
            { $expr: { $lt: ["$metadata.learnerCount", "$enrollmentCapacity"] } }
          ]
        },
        { $inc: { "metadata.learnerCount": 1 } },
        { session, new: true }
      );

      if (!atomicInst) {
        throw new ApiError(400, 'Institution enrollment capacity is full', 'INSTITUTION_CAPACITY_FULL');
      }

      const membership = await InstitutionMembership.create(
        [
          {
            institutionId,
            userId,
            memberType: user.role === 'tutor' ? 'tutor' : 'learner',
            status: user.role === 'tutor' ? 'pending_approval' : 'active',
            paymentStatus: 'not_required'
          }
        ],
        { session }
      );

      await auditService.logAdminAction({
        actorUserId: userId,
        targetUserId: userId,
        action: 'MEMBERSHIP_CREATED',
        metadata: { institutionId, membershipId: membership[0]._id },
        requestMeta
      });

      // Send confirmation in-app and email
      try {
        await notificationService.createNotification({
          userId: userId.toString(),
          title: 'Enrollment Completed',
          message: `Institution access granted for "${inst.name}".`,
          type: 'course'
        });

        await emailService.sendMail({
          to: user.email,
          name: user.name,
          subject: `Enrollment Completed: ${inst.name}`,
          text: `Hello ${user.name}, you have successfully enrolled in ${inst.name}. Access has been granted.`,
          html: `<p>Hello ${user.name},</p><p>You have successfully enrolled in <strong>${inst.name}</strong>. Access has been granted.</p>`
        });

        await notifyInstitutionAdminsOfEnrollment({
          institutionId,
          learner: user,
          institutionName: inst.name,
          membershipId: membership[0]._id
        });
      } catch (err) {
        console.error('[Notification] Free enrollment notification failed:', err.message);
      }

      return {
        message: 'Enrollment successful.',
        data: {
          status: 'completed',
          membership: membership[0]
        }
      };
    });
  }

  // Scenario B: Paid Enrollment (Razorpay)
  // Check Idempotency Key
  if (idempotencyKey) {
    const existingRequest = await EnrollmentRequest.findOne({ idempotencyKey });
    if (existingRequest) {
      if (['pending_payment', 'payment_processing'].includes(existingRequest.status)) {
        return {
          message: 'Existing pending payment found.',
          data: {
            status: existingRequest.status,
            requestId: existingRequest._id,
            paymentReference: existingRequest.paymentReference,
            feeSnapshot: existingRequest.feeSnapshot
          }
        };
      }
    }
  }

  // Concurrency Gate: Check if user already has an active pending request
  const activeRequest = await EnrollmentRequest.findOne({
    userId,
    institutionId,
    status: { $in: ['pending_payment', 'payment_processing'] }
  });

  if (activeRequest) {
    return {
      message: 'Pending enrollment already exists.',
      data: {
        status: activeRequest.status,
        requestId: activeRequest._id,
        paymentReference: activeRequest.paymentReference,
        feeSnapshot: activeRequest.feeSnapshot
      }
    };
  }

  // Generate unique enrollment reference & snap fees
  const totalInitialCost = feePlan.registrationFee + feePlan.joiningFee;
  const feeSnapshot = {
    registrationFee: feePlan.registrationFee,
    joiningFee: feePlan.joiningFee,
    monthlyFee: feePlan.monthlyFee,
    totalInitialCost,
    currency: feePlan.currency || 'INR'
  };

  // Create Razorpay Order
  let razorpayOrder = null;
  try {
    const orderOptions = {
      amount: Math.round(totalInitialCost * 100), // amount in paise
      currency: feeSnapshot.currency,
      receipt: `inst_${userId.toString().slice(-6)}_${institutionId.toString().slice(-6)}_${Date.now().toString().slice(-4)}`
    };
    razorpayOrder = await razorpay.orders.create(orderOptions);
  } catch (error) {
    console.error('[Razorpay Order Creation Error]', error);
    throw new ApiError(500, 'Failed to initialize payment order');
  }

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes TTL

  const newRequest = await EnrollmentRequest.create({
    userId,
    institutionId,
    status: 'pending_payment',
    paymentReference: razorpayOrder.id,
    feeSnapshot,
    idempotencyKey,
    expiresAt
  });

  await auditService.logAdminAction({
    actorUserId: userId,
    targetUserId: userId,
    action: 'PAYMENT_STARTED',
    metadata: { requestId: newRequest._id, orderId: razorpayOrder.id, feeSnapshot },
    requestMeta
  });

  // Notify learner that payment process has started
  try {
    await notificationService.createNotification({
      userId: userId.toString(),
      title: 'Payment Initiated',
      message: `Your enrollment payment for "${inst.name}" has been initiated. Please complete the payment to activate your membership.`,
      type: 'system'
    });
  } catch (notifErr) {
    console.error('[Notification] Payment initiation notification failed:', notifErr.message);
  }

  return {
    message: 'Enrollment initiated. Payment required.',
    data: {
      status: 'pending_payment',
      requestId: newRequest._id,
      paymentReference: razorpayOrder.id,
      feeSnapshot
    }
  };
};

/**
 * Cancel a pending enrollment request
 */
const cancelRequest = async ({ requestId, userId, requestMeta }) => {
  const req = await EnrollmentRequest.findOne({
    _id: requestId,
    userId,
    status: { $in: ['pending_payment', 'payment_processing'] }
  });

  if (!req) {
    throw new ApiError(404, 'No cancelable pending request found', 'REQUEST_NOT_FOUND');
  }

  req.status = 'cancelled';
  await req.save();

  await auditService.logAdminAction({
    actorUserId: userId,
    targetUserId: userId,
    action: 'PAYMENT_FAILED',
    metadata: { requestId, reason: 'cancelled_by_user' },
    requestMeta
  });

  return {
    message: 'Enrollment request cancelled successfully.'
  };
};

/**
 * Complete enrollment registration upon payment validation
 */
const processPaymentSuccess = async ({ enrollmentRequest, transactionId, orderId, webhookVerified, session }) => {
  const { userId, institutionId, feeSnapshot } = enrollmentRequest;

  // 1. Gating check: User must still be active and not deleted
  const user = await User.findOne({ _id: userId, deletedAt: null }).session(session);
  if (!user) {
    throw new ApiError(404, 'User no longer exists', 'USER_NOT_FOUND');
  }
  if (['suspended', 'blocked', 'banned'].includes(user.status)) {
    throw new ApiError(403, 'User account is suspended or blocked', 'ACCOUNT_NOT_ACTIVE');
  }

  // 2. Gating check: Institution must still be active, published, and not deleted
  const inst = await Institution.findOne({ _id: institutionId, status: 'active', isPublished: true }).session(session);
  if (!inst) {
    throw new ApiError(404, 'Institution is no longer available', 'INSTITUTION_NO_LONGER_AVAILABLE');
  }

  // 3. Duplicate protection check
  const existing = await InstitutionMembership.findOne({ institutionId, userId }).session(session);
  if (existing) {
    if (existing.status === 'active') {
      // Already active, just resolve as processed
      enrollmentRequest.status = 'completed';
      await enrollmentRequest.save({ session });
      return { status: 'already_processed', message: 'Already enrolled active membership exists.' };
    }
  }

  // 4. Concurrency Capacity atomic update check
  const atomicInst = await Institution.findOneAndUpdate(
    {
      _id: institutionId,
      status: 'active',
      isPublished: true,
      $or: [
        { enrollmentCapacity: null },
        { $expr: { $lt: ["$metadata.learnerCount", "$enrollmentCapacity"] } }
      ]
    },
    { $inc: { "metadata.learnerCount": 1 } },
    { session, new: true }
  );

  if (!atomicInst) {
    throw new ApiError(400, 'Institution capacity full', 'INSTITUTION_CAPACITY_FULL');
  }

  // 5. Create Payment record
  const [newPayment] = await Payment.create(
    [
      {
        learnerId: userId,
        institutionId,
        enrollmentRequestId: enrollmentRequest._id,
        paymentType: 'institution_enrollment',
        amount: feeSnapshot.totalInitialCost,
        currency: feeSnapshot.currency,
        gateway: 'razorpay',
        transactionId,
        orderId,
        paymentStatus: 'success',
        webhookVerified,
        paidAt: new Date()
      }
    ],
    { session }
  );

  // 6. Create InstitutionMembership
  const nextMembershipStatus = user.role === 'tutor' ? 'pending_approval' : 'active';
  const newMembership = await InstitutionMembership.create(
    [
      {
        institutionId,
        userId,
        memberType: user.role === 'tutor' ? 'tutor' : 'learner',
        status: nextMembershipStatus,
        paymentStatus: 'paid',
        joinedAt: new Date()
      }
    ],
    { session }
  );

  // 7. Update EnrollmentRequest status
  enrollmentRequest.status = 'completed';
  await enrollmentRequest.save({ session });

  // 8. Log audit records
  await auditService.logAdminAction({
    actorUserId: userId,
    targetUserId: userId,
    action: 'PAYMENT_COMPLETED',
    metadata: { transactionId, amount: feeSnapshot.totalInitialCost },
    requestMeta: null
  });

  await auditService.logAdminAction({
    actorUserId: userId,
    targetUserId: userId,
    action: 'ENROLLMENT_COMPLETED',
    metadata: { membershipId: newMembership[0]._id },
    requestMeta: null
  });

  // 9. Invoice generation + notifications (fire-and-forget)
  try {
    // Generate institution invoice PDF
    let invoiceBuffer = null;
    try {
      invoiceBuffer = await generateInstitutionInvoicePdf(newPayment, inst, enrollmentRequest, user);
      await auditService.logAdminAction({
        actorUserId: userId,
        targetUserId: userId,
        action: 'INVOICE_GENERATED',
        metadata: { transactionId, institutionId, invoiceFormat: 'INV-YYYYMM-XXXXXX' },
        requestMeta: null
      });
    } catch (pdfErr) {
      console.error('[Invoice] Institution invoice generation failed:', pdfErr.message);
    }

    // In-app notifications
    await notificationService.createNotification({
      userId: userId.toString(),
      title: 'Payment Successful!',
      message: `Your payment for "${inst.name}" was processed successfully.`,
      type: 'success'
    });
    await notificationService.createNotification({
      userId: userId.toString(),
      title: 'Enrollment Activated',
      message: `You now have access to institution resources at "${inst.name}".`,
      type: 'course'
    });
    if (invoiceBuffer) {
      await notificationService.createNotification({
        userId: userId.toString(),
        title: 'Invoice Available',
        message: 'Your enrollment invoice is ready. You can download it from your payment history.',
        type: 'system'
      });
    }

    // Email with invoice attachment
    const emailPayload = {
      to: user.email,
      name: user.name,
      subject: `Payment Confirmed & Access Granted: ${inst.name}`,
      text: `Hello ${user.name}, your payment of ${feeSnapshot.currency} ${feeSnapshot.totalInitialCost} for ${inst.name} has been received. Your invoice is attached.`,
      html: `<p>Hello ${user.name},</p><p>Your payment of <strong>${feeSnapshot.currency} ${feeSnapshot.totalInitialCost}</strong> for <strong>${inst.name}</strong> has been received.</p><p>Access to institution resources has been activated.</p><p>Your invoice is attached to this email.</p>`
    };
    if (invoiceBuffer) {
      emailPayload.attachments = [{
        content: invoiceBuffer.toString('base64'),
        name: `Invoice-${transactionId}.pdf`,
        type: 'application/pdf',
        disposition: 'attachment'
      }];
    }
    await emailService.sendMail(emailPayload);

    await notifyInstitutionAdminsOfEnrollment({
      institutionId,
      learner: user,
      institutionName: inst.name,
      membershipId: newMembership[0]._id
    });

    // Capacity warning: if institution is >= 80% full, notify institution admin
    if (atomicInst.enrollmentCapacity && atomicInst.enrollmentCapacity > 0) {
      const fillRatio = atomicInst.metadata.learnerCount / atomicInst.enrollmentCapacity;
      if (fillRatio >= CAPACITY_WARNING_THRESHOLD) {
        const adminUsers = await User.find({
          institutionId,
          role: { $in: ['institution_admin', 'admin'] },
          deletedAt: null
        }).select('_id').lean();
        for (const admin of adminUsers) {
          await notificationService.createNotification({
            userId: admin._id.toString(),
            title: 'Capacity Warning',
            message: `"${inst.name}" is at ${Math.round(fillRatio * 100)}% capacity (${atomicInst.metadata.learnerCount}/${atomicInst.enrollmentCapacity} learners). Consider raising the limit.`,
            type: 'warning'
          });
        }
        await auditService.logAdminAction({
          actorUserId: userId,
          targetUserId: userId,
          action: 'CAPACITY_WARNING',
          metadata: { institutionId, learnerCount: atomicInst.metadata.learnerCount, capacity: atomicInst.enrollmentCapacity, fillPercent: Math.round(fillRatio * 100) },
          requestMeta: null
        });
      }
    }
  } catch (err) {
    console.error('[Notification] Post-payment notification error:', err.message);
  }

  return { status: 'success', message: 'Enrollment successful. Payment verified.' };
};

/**
 * Verify Razorpay payment and complete enrollment registration
 */
const verifyPaymentDirect = async ({ userId, requestId, razorpay_order_id, razorpay_payment_id, razorpay_signature, requestMeta }) => {
  const secret = env.razorpay.keySecret;
  if (!secret) throw new Error('Razorpay secret key not configured');

  const generatedSignature = crypto
    .createHmac('sha256', secret)
    .update(razorpay_order_id + '|' + razorpay_payment_id)
    .digest('hex');

  if (generatedSignature !== razorpay_signature) {
    throw new ApiError(400, 'Invalid payment signature', 'INVALID_SIGNATURE');
  }

  // Idempotency: verify if already processed
  const existingPayment = await Payment.findOne({ transactionId: razorpay_payment_id });
  if (existingPayment && existingPayment.paymentStatus === 'success') {
    return { status: 'already_processed', message: 'Payment already processed.' };
  }

  const enrollmentRequest = await EnrollmentRequest.findOne({
    _id: requestId,
    userId,
    paymentReference: razorpay_order_id
  });

  if (!enrollmentRequest) {
    throw new ApiError(404, 'Enrollment request not found for order', 'REQUEST_NOT_FOUND');
  }

  if (enrollmentRequest.status === 'completed') {
    return { status: 'already_processed', message: 'Enrollment already completed.' };
  }

  // Enforce validation & atomicity via transactions
  return await runInTransaction(async (session) => {
    return await processPaymentSuccess({
      enrollmentRequest,
      transactionId: razorpay_payment_id,
      orderId: razorpay_order_id,
      webhookVerified: false,
      session
    });
  });
};

/**
 * Cron/reconciliation task to recover stale or timed-out requests
 */
const reconcilePayments = async () => {
  const staleTime = new Date(Date.now() - 15 * 60 * 1000); // 15 mins
  
  const staleRequests = await EnrollmentRequest.find({
    status: { $in: ['pending_payment', 'payment_processing'] },
    expiresAt: { $lte: new Date() }
  });

  console.log(`[Reconciliation] Processing ${staleRequests.length} stale enrollment requests.`);

  let expiredCount = 0;
  let reconciledCount = 0;

  for (const req of staleRequests) {
    try {
      // Check Razorpay status first
      let orderPaid = false;
      let paymentId = null;
      let amountPaid = 0;

      try {
        const orderPayments = await razorpay.orders.fetchPayments(req.paymentReference);
        const captures = orderPayments.items.filter(p => p.status === 'captured');
        if (captures.length > 0) {
          orderPaid = true;
          paymentId = captures[0].id;
          amountPaid = captures[0].amount / 100;
        }
      } catch (err) {
        console.warn(`[Reconciliation] Failed fetching order payments for ${req.paymentReference}:`, err.message);
      }

      if (orderPaid) {
        // Reconcile and activate enrollment
        await runInTransaction(async (session) => {
          await processPaymentSuccess({
            enrollmentRequest: req,
            transactionId: paymentId,
            orderId: req.paymentReference,
            webhookVerified: true,
            session
          });
        });
        reconciledCount++;
      } else {
        // Expire request
        req.status = 'expired';
        await req.save();
        expiredCount++;
      }
    } catch (err) {
      console.error(`[Reconciliation Failed] Error processing request ${req._id}:`, err.message);
    }
  }

  return { expiredCount, reconciledCount };
};

/**
 * Admin: Update membership status
 */
const adminUpdateMembership = async ({ membershipId, status, reason, adminUser, requestMeta }) => {
  const membership = await InstitutionMembership.findById(membershipId);
  if (!membership) {
    throw new ApiError(404, 'Membership not found', 'MEMBERSHIP_NOT_FOUND');
  }

  const previousStatus = membership.status;
  membership.status = status;
  if (status === 'cancelled') {
    await Payment.updateMany(
      { learnerId: membership.userId, institutionId: membership.institutionId, paymentStatus: 'success' },
      { paymentStatus: 'refunded', refundedAt: new Date() }
    );
  }
  await membership.save();

  let auditAction = 'MEMBERSHIP_ACTIVATED';
  if (status === 'suspended') auditAction = 'MEMBERSHIP_SUSPENDED';
  if (status === 'cancelled') auditAction = 'MEMBERSHIP_CANCELLED';

  await auditService.logAdminAction({
    actorUserId: adminUser.id || adminUser._id,
    targetUserId: membership.userId,
    action: auditAction,
    metadata: {
      membershipId,
      institutionId: membership.institutionId,
      previousStatus,
      nextStatus: status,
      reason: reason || ''
    },
    requestMeta
  });

  return {
    message: `Membership status updated to ${status} successfully.`,
    data: { membership }
  };
};

/**
 * Analytics and Conversion rates tracking
 */
const getMonitoringStats = async () => {
  const [
    totalRequests,
    completedRequests,
    failedRequests,
    expiredRequests,
    cancelledRequests,
    membershipsCount,
    paymentsCount
  ] = await Promise.all([
    EnrollmentRequest.countDocuments(),
    EnrollmentRequest.countDocuments({ status: 'completed' }),
    EnrollmentRequest.countDocuments({ status: 'failed' }),
    EnrollmentRequest.countDocuments({ status: 'expired' }),
    EnrollmentRequest.countDocuments({ status: 'cancelled' }),
    InstitutionMembership.countDocuments(),
    Payment.countDocuments({ institutionId: { $ne: null } })
  ]);

  const conversionRate = totalRequests > 0 ? (completedRequests / totalRequests) * 100 : 0;
  const failureRate = totalRequests > 0 ? ((failedRequests + expiredRequests + cancelledRequests) / totalRequests) * 100 : 0;

  // Average Enrollment Time
  const completedList = await EnrollmentRequest.find({ status: 'completed' }).select('createdAt updatedAt').lean();
  let totalTime = 0;
  completedList.forEach(r => {
    totalTime += (r.updatedAt - r.createdAt);
  });
  const averageEnrollmentTimeMinutes = completedList.length > 0 ? (totalTime / completedList.length) / 1000 / 60 : 0;

  return {
    conversionRatePercentage: conversionRate,
    failureRatePercentage: failureRate,
    averageEnrollmentTimeMinutes,
    totalRequests,
    completedRequests,
    failedRequests,
    expiredRequests,
    cancelledRequests,
    membershipsCount,
    paymentsCount
  };
};

const processPaymentSuccessInTransaction = async ({ enrollmentRequest, transactionId, orderId, webhookVerified }) => {
  return await runInTransaction(async (session) => {
    return await processPaymentSuccess({
      enrollmentRequest,
      transactionId,
      orderId,
      webhookVerified,
      session
    });
  });
};

/**
 * Handle payment failure for an enrollment request
 */
const handlePaymentFailureForEnrollment = async ({ enrollmentRequest, transactionId, requestMeta }) => {
  const { userId, institutionId } = enrollmentRequest;

  enrollmentRequest.status = 'failed';
  await enrollmentRequest.save();

  await auditService.logAdminAction({
    actorUserId: userId,
    targetUserId: userId,
    action: 'PAYMENT_FAILED',
    metadata: { transactionId, institutionId, requestId: enrollmentRequest._id },
    requestMeta: requestMeta || null
  });

  // In-app failure notification (fire-and-forget)
  try {
    await notificationService.createNotification({
      userId: userId.toString(),
      title: 'Payment Failed',
      message: 'Your enrollment payment could not be processed. You can retry from the institution page.',
      type: 'error'
    });

    // Fraud detection: if >= 3 failures from same user+institution within 1 hour → FRAUD_ALERT
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentFailures = await EnrollmentRequest.countDocuments({
      userId,
      institutionId,
      status: 'failed',
      updatedAt: { $gte: oneHourAgo }
    });

    if (recentFailures >= 3) {
      await auditService.logAdminAction({
        actorUserId: userId,
        targetUserId: userId,
        action: 'FRAUD_ALERT',
        metadata: { institutionId, recentFailureCount: recentFailures, window: '1_hour', transactionId },
        requestMeta: requestMeta || null
      });

      // Notify platform admins
      const platformAdmins = await User.find({
        role: { $in: ['platform_admin', 'super_admin', 'platform_owner'] },
        deletedAt: null
      }).select('_id').lean();
      for (const admin of platformAdmins) {
        await notificationService.createNotification({
          userId: admin._id.toString(),
          title: '⚠ Fraud Alert',
          message: `User ${userId} has had ${recentFailures} failed enrollment payment attempts in the last hour for institution ${institutionId}.`,
          type: 'warning'
        });
      }
    }
  } catch (notifErr) {
    console.error('[Notification] Payment failure notification error:', notifErr.message);
  }
};

/**
 * Learner: paginated institution payment history
 */
const getPaymentHistory = async ({ userId, page = 1, limit = 20 }) => {
  const skip = (page - 1) * limit;
  const [payments, total] = await Promise.all([
    Payment.find({ learnerId: userId, paymentType: 'institution_enrollment' })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('institutionId', 'name')
      .lean(),
    Payment.countDocuments({ learnerId: userId, paymentType: 'institution_enrollment' })
  ]);
  return {
    payments,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  };
};

/**
 * Admin: list payment records for a specific institution
 * institution_admin can only see their own; platform_admin sees any
 */
const getInstitutionPaymentRecords = async ({ adminUser, institutionId, page = 1, limit = 20 }) => {
  // Boundary check: institution_admin must belong to the requested institution
  if (isInstitutionAdminRole(adminUser.role)) {
    if (String(adminUser.institutionId) !== String(institutionId)) {
      throw new ApiError(403, 'Access denied: you can only view your own institution records', 'FORBIDDEN');
    }
  }

  const skip = (page - 1) * limit;
  const filter = { institutionId, paymentType: 'institution_enrollment' };
  const [payments, total] = await Promise.all([
    Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('learnerId', 'name email')
      .populate('enrollmentRequestId', 'feeSnapshot status')
      .lean(),
    Payment.countDocuments(filter)
  ]);
  return {
    payments,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  };
};

/**
 * Admin: revenue report for institution enrollment payments
 * institution_admin → own institution only; platform_admin/super_admin → all
 */
const getPaymentRevenueReport = async ({ adminUser, institutionId }) => {
  const filter = { paymentType: 'institution_enrollment' };
  if (isInstitutionAdminRole(adminUser.role)) {
    filter.institutionId = adminUser.institutionId;
  } else if (institutionId) {
    filter.institutionId = institutionId;
  }

  const [successPayments, failedRequests, pendingRequests, expiredRequests, refundedPayments] = await Promise.all([
    Payment.find({ ...filter, paymentStatus: 'success' }).select('amount currency').lean(),
    EnrollmentRequest.countDocuments({ ...(filter.institutionId ? { institutionId: filter.institutionId } : {}), status: 'failed' }),
    Payment.countDocuments({ ...filter, paymentStatus: 'pending' }),
    EnrollmentRequest.countDocuments({ ...(filter.institutionId ? { institutionId: filter.institutionId } : {}), status: 'expired' }),
    Payment.countDocuments({ ...filter, paymentStatus: 'refunded' })
  ]);

  const totalRevenue = successPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
  const successCount = successPayments.length;
  const totalAttempts = successCount + failedRequests + expiredRequests;
  const successRate = totalAttempts > 0 ? ((successCount / totalAttempts) * 100).toFixed(2) : '0.00';
  const failureRate = totalAttempts > 0 ? (((failedRequests + expiredRequests) / totalAttempts) * 100).toFixed(2) : '0.00';

  return {
    totalRevenue,
    currency: 'INR',
    successCount,
    failedCount: failedRequests,
    expiredCount: expiredRequests,
    pendingCount: pendingRequests,
    refundedCount: refundedPayments,
    successRatePercent: successRate,
    failureRatePercent: failureRate
  };
};

/**
 * Learner: download institution enrollment invoice PDF on demand
 */
const downloadInstitutionInvoice = async ({ paymentId, userId }) => {
  const payment = await Payment.findOne({
    _id: paymentId,
    learnerId: userId,
    paymentType: 'institution_enrollment',
    paymentStatus: 'success'
  }).lean();

  if (!payment) {
    throw new ApiError(404, 'Invoice not found or payment not completed', 'INVOICE_NOT_FOUND');
  }

  const [institution, enrollmentRequest, user] = await Promise.all([
    payment.institutionId ? require('../models/institution.model').findById(payment.institutionId).lean() : Promise.resolve({}),
    payment.enrollmentRequestId ? EnrollmentRequest.findById(payment.enrollmentRequestId).lean() : Promise.resolve(null),
    User.findById(userId).select('name email').lean()
  ]);

  const buffer = await generateInstitutionInvoicePdf(payment, institution || {}, enrollmentRequest, user || {});
  return { buffer, transactionId: payment.transactionId || payment._id };
};

module.exports = {
  search,
  getDetail,
  enroll,
  cancelRequest,
  verifyPaymentDirect,
  processPaymentSuccess,
  processPaymentSuccessInTransaction,
  reconcilePayments,
  adminUpdateMembership,
  getMonitoringStats,
  handlePaymentFailureForEnrollment,
  getPaymentHistory,
  getInstitutionPaymentRecords,
  getPaymentRevenueReport,
  downloadInstitutionInvoice
};
