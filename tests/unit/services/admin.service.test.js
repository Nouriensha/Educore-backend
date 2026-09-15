const mongoose = require('mongoose');
const adminService = require('../../../src/services/admin.service');
const User = require('../../../src/models/user.model');
const Course = require('../../../src/models/course.model');
const Enrollment = require('../../../src/models/enrollment.model');
const Payment = require('../../../src/models/payment.model');
const Progress = require('../../../src/models/progress.model');
const InstitutionMembership = require('../../../src/models/institutionMembership.model');
const AuditLog = require('../../../src/models/auditLog.model');
const { ApiError } = require('../../../src/utils/errors');
const { ROLES, ACCOUNT_TYPES } = require('../../../src/utils/roles');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { buildUser, buildCourse } = require('../../fixtures/user.fixture');
const { buildEnrollment } = require('../../fixtures/enrollment.fixture');
const emailService = require('../../../src/services/email.service');
const institutionService = require('../../../src/services/institution.service');
const sessionService = require('../../../src/services/session.service');
const razorpay = require('../../../src/config/razorpay');

// Mock Razorpay
jest.mock('../../../src/config/razorpay', () => ({
  payments: {
    refund: jest.fn().mockResolvedValue({
      id: 'rfnd_mock_12345',
      status: 'processed',
      amount: 4999
    })
  }
}));

// Mock session service
jest.mock('../../../src/services/session.service', () => ({
  revokeAllUserSessions: jest.fn().mockResolvedValue(true)
}));

// Mock email service
jest.mock('../../../src/services/email.service', () => ({
  sendTutorApprovedEmail: jest.fn().mockResolvedValue(true),
  sendTutorRejectedEmail: jest.fn().mockResolvedValue(true),
  sendInvitationEmail: jest.fn().mockResolvedValue(true),
  sendRefundApprovedEmail: jest.fn().mockResolvedValue(true),
  sendRefundRejectedEmail: jest.fn().mockResolvedValue(true),
  sendRefundFailedEmail: jest.fn().mockResolvedValue(true)
}));

// Mock institution service
jest.mock('../../../src/services/institution.service', () => ({
  suspendTutorCascade: jest.fn().mockResolvedValue(true)
}));

describe('Admin Service Comprehensive Unit Tests', () => {
  let superAdmin;
  let platformAdmin;
  let institutionAdmin;
  let tutor;
  let learner;
  let institutionId;

  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  beforeEach(async () => {
    await clearDB();
    jest.clearAllMocks();

    institutionId = new mongoose.Types.ObjectId();

    superAdmin = await User.create(buildUser({
      name: 'Global Super Admin',
      email: 'superadmin@example.com',
      role: ROLES.SUPER_ADMIN,
      accountType: ACCOUNT_TYPES.PLATFORM_ADMIN,
      status: 'active',
      emailVerified: true
    }));

    platformAdmin = await User.create(buildUser({
      name: 'Platform Admin',
      email: 'platformadmin@example.com',
      role: ROLES.PLATFORM_ADMIN,
      accountType: ACCOUNT_TYPES.PLATFORM_ADMIN,
      status: 'active',
      emailVerified: true
    }));

    institutionAdmin = await User.create(buildUser({
      name: 'Institution Admin',
      email: 'instadmin@example.com',
      role: ROLES.INSTITUTION_ADMIN,
      accountType: ACCOUNT_TYPES.INSTITUTION_ADMIN,
      status: 'active',
      emailVerified: true,
      institutionId
    }));

    tutor = await User.create(buildUser({
      name: 'Jane Tutor',
      email: 'tutor@example.com',
      role: ROLES.TUTOR,
      accountType: ACCOUNT_TYPES.INSTITUTION_TUTOR,
      status: 'active',
      emailVerified: true,
      institutionId
    }));

    learner = await User.create(buildUser({
      name: 'Bob Learner',
      email: 'learner@example.com',
      role: ROLES.LEARNER,
      accountType: ACCOUNT_TYPES.INDIVIDUAL_LEARNER,
      status: 'active',
      emailVerified: true
    }));
  });

  // =========================================================================
  // 1. ROLE RESTRICTIONS & SECURITY AUDIT (ensureAdminCanModifyTarget)
  // =========================================================================
  describe('Security & Role Modification Restrictions', () => {
    test('should prevent admins from modifying their own administrative state', async () => {
      await expect(adminService.setSuspendStatus({
        targetUserId: platformAdmin._id,
        suspended: true,
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      })).rejects.toThrow('Admins cannot modify their own administrative state');

      try {
        await adminService.setSuspendStatus({
          targetUserId: platformAdmin._id,
          suspended: true,
          actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
        });
      } catch (err) {
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('SELF_ADMIN_CHANGE_DENIED');
      }
    });

    test('should prevent non-super-admins from modifying a super admin', async () => {
      await expect(adminService.setSuspendStatus({
        targetUserId: superAdmin._id,
        suspended: true,
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      })).rejects.toThrow('Only super admins can modify super admins');

      try {
        await adminService.setSuspendStatus({
          targetUserId: superAdmin._id,
          suspended: true,
          actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
        });
      } catch (err) {
        expect(err.statusCode).toBe(403);
        expect(err.code).toBe('SUPER_ADMIN_PROTECTED');
      }
    });

    test('should prevent non-super-admins from granting super admin role', async () => {
      await expect(adminService.changeRole({
        targetUserId: learner._id,
        role: ROLES.SUPER_ADMIN,
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      })).rejects.toThrow('Only super admins can grant super admin role');

      try {
        await adminService.changeRole({
          targetUserId: learner._id,
          role: ROLES.SUPER_ADMIN,
          actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
        });
      } catch (err) {
        expect(err.statusCode).toBe(403);
        expect(err.code).toBe('SUPER_ADMIN_GRANT_DENIED');
      }
    });

    test('should prevent non-platform-admins from granting platform admin role', async () => {
      await expect(adminService.changeRole({
        targetUserId: learner._id,
        role: ROLES.PLATFORM_ADMIN,
        actor: { id: institutionAdmin._id, role: ROLES.INSTITUTION_ADMIN, institutionId }
      })).rejects.toThrow('Only platform admins can grant platform admin role');

      try {
        await adminService.changeRole({
          targetUserId: learner._id,
          role: ROLES.PLATFORM_ADMIN,
          actor: { id: institutionAdmin._id, role: ROLES.INSTITUTION_ADMIN, institutionId }
        });
      } catch (err) {
        expect(err.statusCode).toBe(403);
        expect(err.code).toBe('PLATFORM_ADMIN_GRANT_DENIED');
      }
    });
  });

  // =========================================================================
  // 2. LIST USERS & TENANT ISOLATION
  // =========================================================================
  describe('listUsers', () => {
    test('platform admin can list all users across all institutions', async () => {
      const res = await adminService.listUsers({
        query: { page: 1, limit: 10 },
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.message).toBe('Users retrieved successfully.');
      expect(res.data.users.length).toBe(5);
      expect(res.data.pagination.total).toBe(5);
      expect(res.data.pagination.page).toBe(1);
    });

    test('institution admin only sees users within their institution (tenant isolation)', async () => {
      const res = await adminService.listUsers({
        query: { page: 1, limit: 10 },
        actor: { id: institutionAdmin._id, role: ROLES.INSTITUTION_ADMIN, institutionId }
      });

      // Should only include institutionAdmin and tutor who share institutionId
      expect(res.data.users.length).toBe(2);
      const returnedIds = res.data.users.map((u) => u.id);
      expect(returnedIds).toContain(String(institutionAdmin._id));
      expect(returnedIds).toContain(String(tutor._id));
      expect(returnedIds).not.toContain(String(learner._id));
    });

    test('should filter by role and status', async () => {
      const res = await adminService.listUsers({
        query: { page: 1, limit: 10, role: ROLES.TUTOR, status: 'active' },
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.data.users).toHaveLength(1);
      expect(res.data.users[0].email).toBe('tutor@example.com');
    });

    test('should search users by name or email (case-insensitive regex)', async () => {
      const res = await adminService.listUsers({
        query: { page: 1, limit: 10, search: 'bob' },
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.data.users).toHaveLength(1);
      expect(res.data.users[0].name).toBe('Bob Learner');
    });

    test('should filter users by joined date range and exclude soft-deleted users', async () => {
      // Soft-delete learner
      await User.findByIdAndUpdate(learner._id, { deletedAt: new Date() });

      const from = new Date(Date.now() - 3600000).toISOString();
      const to = new Date(Date.now() + 3600000).toISOString();

      const res = await adminService.listUsers({
        query: { page: 1, limit: 10, joinedFrom: from, joinedTo: to },
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.data.users.length).toBe(4); // learner excluded
      const returnedIds = res.data.users.map((u) => u.id);
      expect(returnedIds).not.toContain(String(learner._id));
    });
  });

  // =========================================================================
  // 3. SUSPEND, BULK SUSPEND, & UNSUSPEND
  // =========================================================================
  describe('setSuspendStatus & bulkSuspendUsers', () => {
    test('should suspend user, reset login attempts, revoke sessions, and log audit', async () => {
      const res = await adminService.setSuspendStatus({
        targetUserId: learner._id,
        suspended: true,
        reason: 'Terms of service violation',
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN },
        requestMeta: { ip: '127.0.0.1' }
      });

      expect(res.message).toBe('User suspended successfully.');
      expect(res.data.user.status).toBe('suspended');

      // Database verification
      const dbUser = await User.findById(learner._id);
      expect(dbUser.status).toBe('suspended');
      expect(dbUser.failedLoginAttempts).toBe(0);
      expect(dbUser.lockUntil).toBeNull();

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(expect.objectContaining({
        userId: learner._id,
        reason: 'admin_suspend'
      }));

      // AuditLog verification
      const audit = await AuditLog.findOne({ targetUserId: learner._id, action: 'SUSPEND_USER' });
      expect(audit).toBeDefined();
      expect(audit.metadata.reason).toBe('Terms of service violation');
    });

    test('should unsuspend user to active if email is verified', async () => {
      await User.findByIdAndUpdate(learner._id, { status: 'suspended', emailVerified: true });

      const res = await adminService.setSuspendStatus({
        targetUserId: learner._id,
        suspended: false,
        reason: 'Resolved violation',
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.message).toBe('User restored successfully.');
      expect(res.data.user.status).toBe('active');
    });

    test('should unsuspend user to pending_verification if email is unverified', async () => {
      await User.findByIdAndUpdate(learner._id, { status: 'suspended', emailVerified: false });

      const res = await adminService.setSuspendStatus({
        targetUserId: learner._id,
        suspended: false,
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.data.user.status).toBe('pending_verification');
    });

    test('should throw 403 ADMIN_ACCOUNT_PROTECTED if attempting to suspend an admin', async () => {
      const legacyAdmin = await User.create(buildUser({
        name: 'Legacy Admin',
        email: 'legacyadmin@example.com',
        role: ROLES.LEGACY_ADMIN
      }));

      await expect(adminService.setSuspendStatus({
        targetUserId: legacyAdmin._id,
        suspended: true,
        actor: { id: superAdmin._id, role: ROLES.SUPER_ADMIN }
      })).rejects.toThrow('Admin accounts cannot be suspended from this page');
    });

    test('should throw 404 USER_NOT_FOUND for non-existent target', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      await expect(adminService.setSuspendStatus({
        targetUserId: nonExistentId,
        suspended: true,
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      })).rejects.toThrow('User not found');
    });

    test('bulkSuspendUsers should deduplicate IDs and return suspended and failed buckets', async () => {
      const user2 = await User.create(buildUser({
        name: 'Second Learner',
        email: 'learner2@example.com',
        role: ROLES.LEARNER
      }));
      const legacyAdmin = await User.create(buildUser({
        name: 'Protected Admin',
        email: 'protected@example.com',
        role: ROLES.LEGACY_ADMIN
      }));

      const res = await adminService.bulkSuspendUsers({
        userIds: [learner._id, user2._id, learner._id, legacyAdmin._id], // duplicate learner & protected admin
        reason: 'Bulk policy check',
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.data.suspended).toHaveLength(2);
      expect(res.data.failed).toHaveLength(1); // legacyAdmin fails because protected
      expect(res.data.failed[0].userId).toBe(String(legacyAdmin._id));
    });
  });

  // =========================================================================
  // 4. BAN & UNBAN STATUS
  // =========================================================================
  describe('setBanStatus', () => {
    test('should ban user, revoke sessions, cascade tutor suspension, and record audit', async () => {
      const res = await adminService.setBanStatus({
        targetUserId: tutor._id,
        banned: true,
        reason: 'Plagiarism detected',
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.message).toBe('User banned successfully.');
      expect(res.data.user.status).toBe('banned');

      // Database verification
      const dbTutor = await User.findById(tutor._id);
      expect(dbTutor.status).toBe('banned');

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(expect.objectContaining({
        userId: tutor._id,
        reason: 'admin_ban'
      }));

      // Cascade tutor suspension called for institution tutor
      expect(institutionService.suspendTutorCascade).toHaveBeenCalledWith({
        tutorId: tutor._id,
        institutionId,
        actorUserId: platformAdmin._id
      });

      const audit = await AuditLog.findOne({ targetUserId: tutor._id, action: 'BAN_USER' });
      expect(audit).toBeDefined();
      expect(audit.metadata.reason).toBe('Plagiarism detected');
    });

    test('should unban user successfully', async () => {
      await User.findByIdAndUpdate(learner._id, { status: 'banned', emailVerified: true });

      const res = await adminService.setBanStatus({
        targetUserId: learner._id,
        banned: false,
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.message).toBe('User unbanned successfully.');
      expect(res.data.user.status).toBe('active');
    });
  });

  // =========================================================================
  // 5. CHANGE ROLE
  // =========================================================================
  describe('changeRole', () => {
    test('should change user role to tutor with institution and upsert membership', async () => {
      const res = await adminService.changeRole({
        targetUserId: learner._id,
        role: ROLES.TUTOR,
        institutionId,
        reason: 'Promoted to tutor',
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.message).toBe('User role changed successfully.');
      expect(res.data.user.role).toBe(ROLES.TUTOR);

      // Verify User in MongoDB
      const updatedUser = await User.findById(learner._id);
      expect(updatedUser.role).toBe(ROLES.TUTOR);
      expect(updatedUser.accountType).toBe(ACCOUNT_TYPES.INSTITUTION_TUTOR);
      expect(String(updatedUser.institutionId)).toBe(String(institutionId));

      // Verify InstitutionMembership upserted
      const membership = await InstitutionMembership.findOne({ userId: learner._id, institutionId });
      expect(membership).toBeDefined();
      expect(membership.memberType).toBe('tutor');
      expect(membership.status).toBe('active');

      // Verify sessions revoked
      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(expect.objectContaining({
        userId: learner._id,
        reason: 'role_changed'
      }));
    });

    test('should clear institutionId and set platform_admin accountType when promoting to platform role', async () => {
      const res = await adminService.changeRole({
        targetUserId: tutor._id,
        role: ROLES.PLATFORM_ADMIN,
        actor: { id: superAdmin._id, role: ROLES.SUPER_ADMIN }
      });

      expect(res.data.user.role).toBe(ROLES.PLATFORM_ADMIN);

      const updatedTutor = await User.findById(tutor._id);
      expect(updatedTutor.institutionId).toBeNull();
      expect(updatedTutor.accountType).toBe(ACCOUNT_TYPES.PLATFORM_ADMIN);
    });
  });

  // =========================================================================
  // 6. SOFT DELETE
  // =========================================================================
  describe('softDelete', () => {
    test('should set deletedAt and status suspended, revoke sessions, and log audit', async () => {
      const res = await adminService.softDelete({
        targetUserId: learner._id,
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.message).toBe('User deleted successfully.');
      
      const dbUser = await User.findById(learner._id);
      expect(dbUser.deletedAt).toBeInstanceOf(Date);
      expect(dbUser.status).toBe('suspended');

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(expect.objectContaining({
        userId: learner._id,
        reason: 'admin_soft_delete'
      }));

      const audit = await AuditLog.findOne({ targetUserId: learner._id, action: 'SOFT_DELETE_USER' });
      expect(audit).toBeDefined();
    });

    test('should throw 404 USER_NOT_FOUND when deleting already soft-deleted user', async () => {
      await User.findByIdAndUpdate(learner._id, { deletedAt: new Date() });

      await expect(adminService.softDelete({
        targetUserId: learner._id,
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      })).rejects.toThrow('User not found');
    });
  });

  // =========================================================================
  // 7. USER PROFILE SUMMARY & TENANT ISOLATION
  // =========================================================================
  describe('getUserProfileSummary', () => {
    test('should return profile summary with enrollments, payments, and audit history', async () => {
      const course = await Course.create(buildCourse(tutor._id));
      await Enrollment.create(buildEnrollment(learner._id, course._id, { progressPercentage: 45 }));
      await Payment.create({
        learnerId: learner._id,
        courseId: course._id,
        amount: 49.99,
        currency: 'INR',
        paymentStatus: 'success',
        paymentType: 'course_purchase',
        transactionId: 'txn_summary_test_123'
      });
      await AuditLog.create({
        actorUserId: platformAdmin._id,
        targetUserId: learner._id,
        action: 'CHANGE_ROLE',
        metadata: { note: 'Initial setup' }
      });

      const res = await adminService.getUserProfileSummary({
        targetUserId: learner._id,
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.message).toBe('User profile summary retrieved successfully.');
      expect(res.data.user.id).toBe(String(learner._id));
      expect(res.data.enrollmentHistory).toHaveLength(1);
      expect(res.data.enrollmentHistory[0].courseTitle).toBe(course.title);
      expect(res.data.paymentHistory).toHaveLength(1);
      expect(res.data.paymentHistory[0].amount).toBe(49.99);
      expect(res.data.activityLog).toHaveLength(1);
      expect(res.data.activityLog[0].action).toBe('CHANGE_ROLE');
    });

    test('institution admin cannot view profile of a user outside their institution', async () => {
      // learner does not have institutionId
      await expect(adminService.getUserProfileSummary({
        targetUserId: learner._id,
        actor: { id: institutionAdmin._id, role: ROLES.INSTITUTION_ADMIN, institutionId }
      })).rejects.toThrow('You are not allowed to view this user profile');

      try {
        await adminService.getUserProfileSummary({
          targetUserId: learner._id,
          actor: { id: institutionAdmin._id, role: ROLES.INSTITUTION_ADMIN, institutionId }
        });
      } catch (err) {
        expect(err.statusCode).toBe(403);
        expect(err.code).toBe('USER_PROFILE_FORBIDDEN');
      }
    });
  });

  // =========================================================================
  // 8. TUTOR APPROVAL & REJECTION LIFECYCLE
  // =========================================================================
  describe('approveTutor & rejectTutor', () => {
    let pendingTutor;
    let tutorMembership;

    beforeEach(async () => {
      pendingTutor = await User.create(buildUser({
        name: 'Pending Applicant',
        email: 'applicant@example.com',
        role: ROLES.TUTOR,
        status: 'pending_approval',
        institutionId
      }));

      tutorMembership = await InstitutionMembership.create({
        userId: pendingTutor._id,
        institutionId,
        memberType: 'tutor',
        status: 'pending_approval'
      });
    });

    test('approveTutor should activate tutor, approve membership, and send email', async () => {
      const res = await adminService.approveTutor({
        targetUserId: pendingTutor._id,
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.message).toBe('Tutor approved successfully.');
      expect(res.data.user.status).toBe('active');

      // Verify User in MongoDB
      const dbUser = await User.findById(pendingTutor._id);
      expect(dbUser.status).toBe('active');
      expect(dbUser.profile.tutorApproval.rejectionReason).toBe('');

      // Verify InstitutionMembership
      const dbMembership = await InstitutionMembership.findById(tutorMembership._id);
      expect(dbMembership.status).toBe('active');
      expect(String(dbMembership.approvedBy)).toBe(String(platformAdmin._id));

      // Verify Email
      expect(emailService.sendTutorApprovedEmail).toHaveBeenCalledWith({
        to: pendingTutor.email,
        name: pendingTutor.name
      });
    });

    test('rejectTutor should set status rejected, cancel membership, revoke sessions, and send email', async () => {
      const res = await adminService.rejectTutor({
        targetUserId: pendingTutor._id,
        reason: 'Insufficient teaching experience',
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.message).toBe('Tutor rejected successfully.');
      expect(res.data.user.status).toBe('rejected');

      const dbUser = await User.findById(pendingTutor._id);
      expect(dbUser.status).toBe('rejected');
      expect(dbUser.profile.tutorApproval.rejectionReason).toBe('Insufficient teaching experience');

      const dbMembership = await InstitutionMembership.findById(tutorMembership._id);
      expect(dbMembership.status).toBe('cancelled');

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(expect.objectContaining({
        userId: pendingTutor._id,
        reason: 'tutor_rejected'
      }));

      expect(emailService.sendTutorRejectedEmail).toHaveBeenCalledWith({
        to: pendingTutor.email,
        name: pendingTutor.name,
        reason: 'Insufficient teaching experience'
      });
    });

    test('institution admin cannot review tutor from another institution (IDOR / Tenant isolation)', async () => {
      const otherInstitutionId = new mongoose.Types.ObjectId();
      const foreignTutor = await User.create(buildUser({
        name: 'Foreign Tutor',
        email: 'foreign@example.com',
        role: ROLES.TUTOR,
        status: 'pending_approval',
        institutionId: otherInstitutionId
      }));

      await expect(adminService.approveTutor({
        targetUserId: foreignTutor._id,
        actor: { id: institutionAdmin._id, role: ROLES.INSTITUTION_ADMIN, institutionId }
      })).rejects.toThrow('You are not allowed to review this tutor account');

      try {
        await adminService.approveTutor({
          targetUserId: foreignTutor._id,
          actor: { id: institutionAdmin._id, role: ROLES.INSTITUTION_ADMIN, institutionId }
        });
      } catch (err) {
        expect(err.statusCode).toBe(403);
        expect(err.code).toBe('TUTOR_REVIEW_FORBIDDEN');
      }
    });

    test('should throw 404 USER_NOT_FOUND if tutor is not in pending_approval', async () => {
      await expect(adminService.approveTutor({
        targetUserId: tutor._id, // tutor.status is 'active'
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      })).rejects.toThrow('Pending tutor not found');
    });
  });

  // =========================================================================
  // 9. ADMIN CREATE USER & BULK REGISTER STUDENTS
  // =========================================================================
  describe('adminCreateUser & bulkRegisterStudents', () => {
    test('adminCreateUser should create user with temporary password and send invitation', async () => {
      const res = await adminService.adminCreateUser({
        name: 'New Student',
        email: 'newstudent@example.com',
        role: ROLES.LEARNER,
        institutionId,
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.data.user.email).toBe('newstudent@example.com');
      expect(res.data.user.status).toBe('active');
      expect(res.data.credentials.temporaryPassword).toBeDefined();
      expect(res.data.emailStatus).toBe('sent');

      // Verify MongoDB document
      const created = await User.findOne({ email: 'newstudent@example.com' });
      expect(created).toBeDefined();
      expect(created.emailVerified).toBe(true);

      // Verify active membership created for institution learner
      const membership = await InstitutionMembership.findOne({ userId: created._id, institutionId });
      expect(membership).toBeDefined();
      expect(membership.status).toBe('active');

      expect(emailService.sendInvitationEmail).toHaveBeenCalledWith(expect.objectContaining({
        to: 'newstudent@example.com',
        name: 'New Student'
      }));
    });

    test('adminCreateUser should throw 409 EMAIL_ALREADY_EXISTS for duplicate email', async () => {
      await expect(adminService.adminCreateUser({
        name: 'Duplicate Bob',
        email: 'learner@example.com', // already registered
        role: ROLES.LEARNER,
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      })).rejects.toThrow('Email is already registered');

      try {
        await adminService.adminCreateUser({
          name: 'Duplicate Bob',
          email: 'learner@example.com',
          role: ROLES.LEARNER,
          actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
        });
      } catch (err) {
        expect(err.statusCode).toBe(409);
        expect(err.code).toBe('EMAIL_ALREADY_EXISTS');
      }
    });

    test('adminCreateUser should handle invitation email failure gracefully', async () => {
      emailService.sendInvitationEmail.mockRejectedValueOnce(new Error('Brevo service down'));

      const res = await adminService.adminCreateUser({
        name: 'Offline Student',
        email: 'offline@example.com',
        role: ROLES.LEARNER,
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.data.emailStatus).toBe('failed');
      expect(res.data.emailError).toBe('Brevo service down');
      expect(res.message).toContain('User created but invitation email failed');
    });

    test('bulkRegisterStudents should register students and collect failures', async () => {
      const students = [
        { name: 'Bulk Student 1', email: 'bulk1@example.com' },
        { name: 'Bulk Student 2', email: 'learner@example.com' }, // duplicate -> fails
        { name: 'Bulk Student 3', email: 'bulk3@example.com' }
      ];

      const res = await adminService.bulkRegisterStudents({
        students,
        actor: { id: platformAdmin._id, role: ROLES.PLATFORM_ADMIN }
      });

      expect(res.data.success).toHaveLength(2);
      expect(res.data.failed).toHaveLength(1);
      expect(res.data.failed[0].email).toBe('learner@example.com');
      expect(res.data.failed[0].reason).toContain('already registered');
    });
  });

  // =========================================================================
  // 10. ANALYTICS & REVENUE EXPORT
  // =========================================================================
  describe('getAnalytics & exportRevenueData', () => {
    let course;

    beforeEach(async () => {
      course = await Course.create(buildCourse(tutor._id, { price: 100 }));
      await Enrollment.create(buildEnrollment(learner._id, course._id));

      await Payment.create([
        {
          learnerId: learner._id,
          courseId: course._id,
          amount: 100,
          currency: 'INR',
          paymentStatus: 'success',
          paymentType: 'course_purchase',
          transactionId: 'txn_rev_1',
          paidAt: new Date()
        },
        {
          learnerId: learner._id,
          courseId: course._id,
          amount: 50,
          currency: 'INR',
          paymentStatus: 'refunded',
          paymentType: 'course_purchase',
          transactionId: 'txn_rev_2',
          paidAt: new Date(),
          refundedAt: new Date()
        }
      ]);
    });

    test('getAnalytics should aggregate revenue, counts, trends, and top courses', async () => {
      const res = await adminService.getAnalytics();

      expect(res.message).toBe('Analytics retrieved successfully');
      expect(res.data.userCount).toBe(5);
      expect(res.data.enrollmentCount).toBe(1);
      expect(res.data.totalRevenue).toBe(100);
      expect(res.data.revenueThisMonth).toBe(100);
      expect(res.data.refundSummary.totalRefunds).toBe(50);
      expect(res.data.refundSummary.refundCount).toBe(1);
      expect(res.data.topCourses.length).toBeGreaterThanOrEqual(1);
      expect(res.data.tutorBreakdown.length).toBeGreaterThanOrEqual(1);
    });

    test('getAnalytics should support filtering by specific courseId and date range', async () => {
      const startDate = new Date(Date.now() - 86400000).toISOString();
      const endDate = new Date(Date.now() + 86400000).toISOString();

      const res = await adminService.getAnalytics({
        courseId: course._id.toString(),
        startDate,
        endDate
      });

      expect(res.data.totalRevenue).toBe(100);
    });

    test('exportRevenueData should generate CSV buffer of payment records', async () => {
      const buffer = await adminService.exportRevenueData({
        courseId: course._id.toString()
      });

      expect(Buffer.isBuffer(buffer)).toBe(true);
      const csvString = buffer.toString('utf-8');
      expect(csvString).toContain('Transaction ID');
      expect(csvString).toContain('txn_rev_1');
      expect(csvString).toContain('txn_rev_2');
    });
  });

  // =========================================================================
  // 11. REFUND WORKFLOWS (getPendingRefunds & processRefund)
  // =========================================================================
  describe('Refund Management', () => {
    let course;
    let enrollment;
    let progress;
    let payment;

    beforeEach(async () => {
      course = await Course.create(buildCourse(tutor._id, { enrollmentCount: 5 }));
      enrollment = await Enrollment.create(buildEnrollment(learner._id, course._id, {
        status: 'refund_pending',
        paymentStatus: 'refund_processing'
      }));
      progress = await Progress.create({
        userId: learner._id,
        courseId: course._id,
        overallPercentage: 20
      });
      payment = await Payment.create({
        learnerId: learner._id,
        courseId: course._id,
        amount: 49.99,
        currency: 'INR',
        paymentStatus: 'refund_pending',
        refundStatus: 'pending',
        transactionId: 'pay_razorpay_valid_123',
        paidAt: new Date()
      });
    });

    test('getPendingRefunds should list payments with pending refund statuses', async () => {
      const res = await adminService.getPendingRefunds();

      expect(res.message).toBe('Refund queue retrieved');
      expect(res.data.refunds).toHaveLength(1);
      expect(res.data.refunds[0]._id.toString()).toBe(payment._id.toString());
    });

    test('processRefund should throw 404 if payment does not exist', async () => {
      const invalidId = new mongoose.Types.ObjectId();
      await expect(adminService.processRefund({
        paymentId: invalidId,
        action: 'approve'
      })).rejects.toThrow('Payment record not found');
    });

    test('processRefund should throw 400 for invalid action', async () => {
      await expect(adminService.processRefund({
        paymentId: payment._id,
        action: 'invalid_action'
      })).rejects.toThrow('Invalid action');
    });

    test('processRefund should throw 400 when retrying a non-failed refund', async () => {
      // payment is refund_pending, not refund_failed
      await expect(adminService.processRefund({
        paymentId: payment._id,
        action: 'retry'
      })).rejects.toThrow('Only failed refunds can be retried');
    });

    test('processRefund should throw 400 when rejecting a non-pending refund', async () => {
      await Payment.findByIdAndUpdate(payment._id, { paymentStatus: 'success' });

      await expect(adminService.processRefund({
        paymentId: payment._id,
        action: 'reject'
      })).rejects.toThrow('Only pending refund requests can be rejected');
    });

    test('processRefund approve should invoke Razorpay, update statuses, cascade enrollment & progress, decrement course counter, and email learner', async () => {
      const res = await adminService.processRefund({
        paymentId: payment._id,
        action: 'approve',
        reason: 'Student dissatisfied with curriculum'
      });

      expect(res.message).toBe('Refund approved and initiated through Razorpay successfully');

      // Verify Razorpay API mock was called with correct paise amount
      expect(razorpay.payments.refund).toHaveBeenCalledWith('pay_razorpay_valid_123', expect.objectContaining({
        amount: 4999, // 49.99 * 100
        notes: expect.objectContaining({
          reason: 'Student dissatisfied with curriculum'
        })
      }));

      // Verify Payment state in MongoDB
      const updatedPayment = await Payment.findById(payment._id);
      expect(updatedPayment.paymentStatus).toBe('refunded');
      expect(updatedPayment.refundStatus).toBe('processed');
      expect(updatedPayment.razorpayRefundId).toBe('rfnd_mock_12345');
      expect(updatedPayment.refundProcessedAt).toBeInstanceOf(Date);

      // Verify Enrollment cascaded to refunded and soft-deleted
      const updatedEnrollment = await Enrollment.findById(enrollment._id);
      expect(updatedEnrollment.status).toBe('refunded');
      expect(updatedEnrollment.paymentStatus).toBe('refunded');
      expect(updatedEnrollment.deletedAt).toBeInstanceOf(Date);

      // Verify Progress soft-deleted
      const updatedProgress = await Progress.findById(progress._id);
      expect(updatedProgress.deletedAt).toBeInstanceOf(Date);

      // Verify Course enrollmentCount decremented
      const updatedCourse = await Course.findById(course._id);
      expect(updatedCourse.enrollmentCount).toBe(4); // 5 - 1

      // Verify email dispatched
      expect(emailService.sendRefundApprovedEmail).toHaveBeenCalledWith(expect.objectContaining({
        to: learner.email,
        amount: 49.99,
        refundId: 'rfnd_mock_12345'
      }));
    });

    test('processRefund approve should handle Razorpay provider failure gracefully and set refund_failed', async () => {
      razorpay.payments.refund.mockRejectedValueOnce(new Error('Gateway timeout from bank'));

      await expect(adminService.processRefund({
        paymentId: payment._id,
        action: 'approve'
      })).rejects.toThrow('Razorpay refund failed: Gateway timeout from bank');

      // Verify state in DB
      const failedPayment = await Payment.findById(payment._id);
      expect(failedPayment.paymentStatus).toBe('refund_failed');
      expect(failedPayment.refundStatus).toBe('failed');
      expect(failedPayment.refundFailureReason).toBe('Gateway timeout from bank');

      const failedEnrollment = await Enrollment.findById(enrollment._id);
      expect(failedEnrollment.status).toBe('refund_failed');
      expect(failedEnrollment.paymentStatus).toBe('refund_failed');

      expect(emailService.sendRefundFailedEmail).toHaveBeenCalledWith(expect.objectContaining({
        to: learner.email,
        reason: 'Gateway timeout from bank'
      }));
    });

    test('processRefund reject should restore enrollment access and send rejection email', async () => {
      const res = await adminService.processRefund({
        paymentId: payment._id,
        action: 'reject',
        reason: 'Course was completed over 80%'
      });

      expect(res.message).toBe('Refund request rejected, access restored');

      // Verify payment marked success & refundStatus rejected
      const dbPayment = await Payment.findById(payment._id);
      expect(dbPayment.paymentStatus).toBe('success');
      expect(dbPayment.refundStatus).toBe('rejected');

      // Verify enrollment restored to active
      const dbEnrollment = await Enrollment.findById(enrollment._id);
      expect(dbEnrollment.status).toBe('active');
      expect(dbEnrollment.paymentStatus).toBe('success');

      expect(emailService.sendRefundRejectedEmail).toHaveBeenCalledWith(expect.objectContaining({
        to: learner.email,
        reason: 'Course was completed over 80%'
      }));
    });

    test('processRefund approve should throw 502 if Razorpay returns status failed', async () => {
      razorpay.payments.refund.mockResolvedValueOnce({
        status: 'failed',
        error_description: 'Card expired or bank declined'
      });

      await expect(adminService.processRefund({
        paymentId: payment._id,
        action: 'approve'
      })).rejects.toThrow('Razorpay refund failed: Card expired or bank declined');

      const failedPayment = await Payment.findById(payment._id);
      expect(failedPayment.paymentStatus).toBe('refund_failed');
      expect(failedPayment.refundFailureReason).toBe('Card expired or bank declined');
    });

    test('processRefund retry should re-attempt refund when status is refund_failed', async () => {
      await Payment.findByIdAndUpdate(payment._id, { paymentStatus: 'refund_failed', refundStatus: 'failed' });
      await Enrollment.findByIdAndUpdate(enrollment._id, { status: 'refund_failed', paymentStatus: 'refund_failed' });

      const res = await adminService.processRefund({
        paymentId: payment._id,
        action: 'retry',
        reason: 'Retry after bank network recovered'
      });

      expect(res.message).toBe('Refund approved and initiated through Razorpay successfully');
      const updatedPayment = await Payment.findById(payment._id);
      expect(updatedPayment.paymentStatus).toBe('refunded');
      expect(updatedPayment.refundAttempts).toBe(1);
    });
  });
});
