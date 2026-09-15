const mongoose = require('mongoose');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { buildUser } = require('../../fixtures/user.fixture');
const { hashPassword, comparePassword } = require('../../../src/utils/password');

// Models
const User = require('../../../src/models/user.model');
const Institution = require('../../../src/models/institution.model');
const InstitutionAdmin = require('../../../src/models/institutionAdmin.model');
const InstitutionSettings = require('../../../src/models/institutionSettings.model');
const Course = require('../../../src/models/course.model');
const Batch = require('../../../src/models/batch.model');
const Enrollment = require('../../../src/models/enrollment.model');
const Payment = require('../../../src/models/payment.model');
const Progress = require('../../../src/models/progress.model');

// Mock Redis Store
const redisStore = new Map();
const mockRedis = {
  get: jest.fn().mockImplementation(async (key) => redisStore.get(key) || null),
  set: jest.fn().mockImplementation(async (key, val) => {
    redisStore.set(key, String(val));
    return 'OK';
  }),
  del: jest.fn().mockImplementation(async (key) => {
    const existed = redisStore.has(key);
    redisStore.delete(key);
    return existed ? 1 : 0;
  }),
  quit: jest.fn().mockResolvedValue(),
  ping: jest.fn().mockResolvedValue('PONG')
};
jest.mock('../../../src/config/redis', () => mockRedis);

// Mock Services
const emailService = require('../../../src/services/email.service');
const auditService = require('../../../src/services/audit.service');
const sessionService = require('../../../src/services/session.service');

jest.mock('../../../src/services/email.service', () => ({
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
  sendInstitutionalOnboardingEmail: jest.fn().mockResolvedValue(true)
}));

jest.mock('../../../src/services/audit.service', () => ({
  logAdminAction: jest.fn().mockResolvedValue(true)
}));

jest.mock('../../../src/services/session.service', () => ({
  createSession: jest.fn().mockResolvedValue({
    accessToken: 'mock_access_token_platform',
    refreshToken: 'mock_refresh_token_platform'
  }),
  rotateRefreshToken: jest.fn().mockResolvedValue({
    accessToken: 'mock_rotated_access_token',
    refreshToken: 'mock_rotated_refresh_token'
  }),
  revokeRefreshToken: jest.fn().mockResolvedValue(true),
  revokeAllUserSessions: jest.fn().mockResolvedValue(true)
}));

const platformService = require('../../../src/services/platform.service');

describe('Platform Service Comprehensive Behavioral & Security Unit Tests', () => {
  let platformOwner;
  let otherPlatformOwner;
  let regularUser;
  let institutionAdmin;
  let defaultInstitution;

  let origStartSession;

  beforeAll(async () => {
    await connectDB();
    origStartSession = mongoose.startSession.bind(mongoose);
    jest.spyOn(mongoose, 'startSession').mockImplementation(async () => {
      const session = await origStartSession();
      session.startTransaction = () => {};
      session.commitTransaction = async () => {};
      session.abortTransaction = async () => {};
      session.inTransaction = () => false;
      return session;
    });
  });

  afterAll(async () => {
    if (mongoose.startSession.mockRestore) {
      mongoose.startSession.mockRestore();
    }
    await closeDB();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    redisStore.clear();

    const passwordHash = await hashPassword('SecurePlatformOwnerPassword123!');

    platformOwner = await User.create({
      name: 'Root Platform Owner',
      email: 'owner@educore.platform',
      passwordHash,
      role: 'platform_owner',
      status: 'active',
      emailVerified: true
    });

    otherPlatformOwner = await User.create({
      name: 'Secondary Platform Owner',
      email: 'owner2@educore.platform',
      passwordHash,
      role: 'platform_owner',
      status: 'active',
      emailVerified: true
    });

    regularUser = await User.create({
      name: 'Learner One',
      email: 'learner1@example.com',
      passwordHash,
      role: 'learner',
      status: 'active',
      emailVerified: true
    });

    institutionAdmin = await User.create({
      name: 'Inst Admin One',
      email: 'instadmin@example.com',
      passwordHash,
      role: 'institution_admin',
      status: 'active',
      emailVerified: true
    });

    defaultInstitution = await Institution.create({
      name: 'Apex Institute of Technology',
      domain: 'apex-tech.edu',
      email: 'contact@apex-tech.edu',
      code: 'APEX01',
      description: 'Engineering and Tech',
      owner: institutionAdmin._id,
      status: 'active',
      isPublished: true,
      acceptsEnrollments: true
    });

    institutionAdmin.institutionId = defaultInstitution._id;
    await institutionAdmin.save();
  });

  afterEach(async () => {
    await clearDB();
  });

  // ==========================================
  // 1. LOGIN
  // ==========================================
  describe('login', () => {
    it('should login successfully with valid platform_owner credentials', async () => {
      const res = await platformService.login({
        payload: {
          email: 'owner@educore.platform',
          password: 'SecurePlatformOwnerPassword123!',
          rememberMe: true
        },
        requestMeta: { ip: '127.0.0.1' }
      });

      expect(res.message).toBe('Platform login successful.');
      expect(res.data.role).toBe('platform_owner');
      expect(res.data.accessToken).toBe('mock_access_token_platform');
      expect(res.data.refreshToken).toBe('mock_refresh_token_platform');

      const updatedOwner = await User.findById(platformOwner._id);
      expect(updatedOwner.failedLoginAttempts).toBe(0);
      expect(updatedOwner.lockUntil).toBeNull();
      expect(updatedOwner.lastLoginAt).toBeTruthy();

      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ rememberMe: true })
      );
    });

    it('should reject non-platform_owner accounts attempting to use platform login with 401 INVALID_CREDENTIALS', async () => {
      await expect(
        platformService.login({
          payload: {
            email: 'learner1@example.com',
            password: 'SecurePlatformOwnerPassword123!'
          }
        })
      ).rejects.toThrow('Invalid email or password');
    });

    it('should reject non-existent emails with 401 INVALID_CREDENTIALS', async () => {
      await expect(
        platformService.login({
          payload: {
            email: 'nonexistent@educore.platform',
            password: 'SomePassword'
          }
        })
      ).rejects.toThrow('Invalid email or password');
    });

    it('should reject wrong password, increment failedLoginAttempts atomically', async () => {
      await expect(
        platformService.login({
          payload: {
            email: 'owner@educore.platform',
            password: 'WrongPassword123'
          }
        })
      ).rejects.toThrow('Invalid email or password');

      const updatedOwner = await User.findById(platformOwner._id);
      expect(updatedOwner.failedLoginAttempts).toBe(1);
    });

    it('should lock account when failedLoginAttempts reaches maximum threshold', async () => {
      // Set to 4 failed attempts so next failed attempt hits 5 (max)
      platformOwner.failedLoginAttempts = 4;
      await platformOwner.save();

      await expect(
        platformService.login({
          payload: {
            email: 'owner@educore.platform',
            password: 'WrongPassword123'
          }
        })
      ).rejects.toThrow('Invalid email or password');

      const lockedOwner = await User.findById(platformOwner._id);
      expect(lockedOwner.lockUntil).toBeTruthy();
      expect(lockedOwner.lockUntil.getTime()).toBeGreaterThan(Date.now());
    });

    it('should reject immediately with 423 ACCOUNT_LOCKED if account has active lock', async () => {
      platformOwner.lockUntil = new Date(Date.now() + 15 * 60 * 1000);
      await platformOwner.save();

      await expect(
        platformService.login({
          payload: {
            email: 'owner@educore.platform',
            password: 'SecurePlatformOwnerPassword123!'
          }
        })
      ).rejects.toThrow('Account is temporarily locked');
    });

    it('should clear lock and reset failed attempts if lock has expired', async () => {
      platformOwner.lockUntil = new Date(Date.now() - 1000); // 1s in the past
      platformOwner.failedLoginAttempts = 5;
      await platformOwner.save();

      const res = await platformService.login({
        payload: {
          email: 'owner@educore.platform',
          password: 'SecurePlatformOwnerPassword123!'
        }
      });

      expect(res.message).toBe('Platform login successful.');
      const updatedOwner = await User.findById(platformOwner._id);
      expect(updatedOwner.failedLoginAttempts).toBe(0);
      expect(updatedOwner.lockUntil).toBeNull();
    });

    it('should throw 403 EMAIL_VERIFICATION_REQUIRED if emailVerified is false or status is pending_verification', async () => {
      platformOwner.emailVerified = false;
      platformOwner.status = 'pending_verification';
      await platformOwner.save();

      await expect(
        platformService.login({
          payload: {
            email: 'owner@educore.platform',
            password: 'SecurePlatformOwnerPassword123!'
          }
        })
      ).rejects.toThrow('Email verification required');
    });

    it('should throw 403 ACCOUNT_NOT_ACTIVE if account status is banned or suspended', async () => {
      platformOwner.status = 'banned';
      await platformOwner.save();

      await expect(
        platformService.login({
          payload: {
            email: 'owner@educore.platform',
            password: 'SecurePlatformOwnerPassword123!'
          }
        })
      ).rejects.toThrow('Account is not active');
    });
  });

  // ==========================================
  // 2. FORGOT PASSWORD
  // ==========================================
  describe('forgotPassword', () => {
    it('should store reset token in Redis and send password reset email for active platform_owner', async () => {
      const res = await platformService.forgotPassword({
        payload: { email: 'owner@educore.platform' }
      });

      expect(res.message).toBe('If the email exists, password reset instructions have been sent.');
      expect(mockRedis.set).toHaveBeenCalledTimes(1);
      expect(emailService.sendPasswordResetEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'owner@educore.platform',
          name: 'Root Platform Owner'
        })
      );
    });

    it('should return generic message and avoid sending email if email does not belong to a platform_owner', async () => {
      const res = await platformService.forgotPassword({
        payload: { email: 'learner1@example.com' }
      });

      expect(res.message).toBe('If the email exists, password reset instructions have been sent.');
      expect(mockRedis.set).not.toHaveBeenCalled();
      expect(emailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('should return generic message even if email service throws an error', async () => {
      emailService.sendPasswordResetEmail.mockRejectedValueOnce(new Error('SMTP connection failure'));

      const res = await platformService.forgotPassword({
        payload: { email: 'owner@educore.platform' }
      });

      expect(res.message).toBe('If the email exists, password reset instructions have been sent.');
    });
  });

  // ==========================================
  // 3. RESET PASSWORD
  // ==========================================
  describe('resetPassword', () => {
    const { hashToken } = require('../../../src/utils/crypto');

    it('should throw 400 RESET_TOKEN_INVALID if token is missing', async () => {
      await expect(
        platformService.resetPassword({
          payload: { password: 'NewPassword123!' }
        })
      ).rejects.toThrow('Invalid or expired reset token');
    });

    it('should throw 400 RESET_TOKEN_INVALID if token is not found in Redis', async () => {
      await expect(
        platformService.resetPassword({
          payload: { token: 'unregistered_token_123', password: 'NewPassword123!' }
        })
      ).rejects.toThrow('Invalid or expired reset token');
    });

    it('should throw 400 RESET_TOKEN_INVALID and delete key if Redis payload is malformed JSON', async () => {
      const rawToken = 'corrupt_json_token';
      const tokenHash = hashToken(rawToken);
      redisStore.set(`platform-password-reset:${tokenHash}`, 'INVALID_JSON_RAW');

      await expect(
        platformService.resetPassword({
          payload: { token: rawToken, password: 'NewPassword123!' }
        })
      ).rejects.toThrow('Invalid or expired reset token');

      expect(redisStore.has(`platform-password-reset:${tokenHash}`)).toBe(false);
    });

    it('should throw 400 RESET_TOKEN_INVALID if user matching token does not exist', async () => {
      const rawToken = 'ghost_user_token';
      const tokenHash = hashToken(rawToken);
      redisStore.set(
        `platform-password-reset:${tokenHash}`,
        JSON.stringify({ userId: new mongoose.Types.ObjectId().toString() })
      );

      await expect(
        platformService.resetPassword({
          payload: { token: rawToken, password: 'NewPassword123!' }
        })
      ).rejects.toThrow('Invalid or expired reset token');

      expect(redisStore.has(`platform-password-reset:${tokenHash}`)).toBe(false);
    });

    it('should reset password, revoke sessions, and remove token from Redis on success', async () => {
      const rawToken = 'valid_reset_token_abc';
      const tokenHash = hashToken(rawToken);
      redisStore.set(
        `platform-password-reset:${tokenHash}`,
        JSON.stringify({ userId: platformOwner._id.toString() })
      );

      const res = await platformService.resetPassword({
        payload: {
          token: rawToken,
          password: 'BrandNewOwnerPassword999!'
        },
        requestMeta: { ip: '127.0.0.1' }
      });

      expect(res.message).toBe('Password reset successful.');
      expect(res.data.redirectTo).toBe('/platform/login');

      // Verify DB password update
      const updatedUser = await User.findById(platformOwner._id).select('+passwordHash');
      const matches = await comparePassword('BrandNewOwnerPassword999!', updatedUser.passwordHash);
      expect(matches).toBe(true);
      expect(updatedUser.failedLoginAttempts).toBe(0);

      // Verify sessions revoked and token deleted
      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: platformOwner._id,
          reason: 'platform_password_reset'
        })
      );
      expect(redisStore.has(`platform-password-reset:${tokenHash}`)).toBe(false);
    });
  });

  // ==========================================
  // 4. REFRESH & LOGOUT
  // ==========================================
  describe('refresh & logout', () => {
    it('should rotate refresh token via rotateRefreshToken and return new token pair', async () => {
      const res = await platformService.refresh({
        payload: { refreshToken: 'valid_old_refresh_token' },
        requestMeta: { ip: '127.0.0.1' }
      });

      expect(res.message).toBe('Platform token refreshed successfully.');
      expect(res.data.accessToken).toBe('mock_rotated_access_token');
      expect(sessionService.rotateRefreshToken).toHaveBeenCalledWith({
        refreshToken: 'valid_old_refresh_token',
        requestMeta: { ip: '127.0.0.1' }
      });
    });

    it('should revoke refresh token on logout', async () => {
      const res = await platformService.logout({
        payload: { refreshToken: 'token_to_revoke' },
        requestMeta: { ip: '127.0.0.1' }
      });

      expect(res.message).toBe('Platform logout successful.');
      expect(sessionService.revokeRefreshToken).toHaveBeenCalledWith({
        refreshToken: 'token_to_revoke',
        requestMeta: { ip: '127.0.0.1' }
      });
    });
  });

  // ==========================================
  // 5. LIST USERS
  // ==========================================
  describe('listUsers', () => {
    it('should return paginated list of non-deleted platform users', async () => {
      const res = await platformService.listUsers({
        query: { page: 1, limit: 10 }
      });

      expect(res.message).toBe('Platform users retrieved successfully.');
      expect(res.data.users.length).toBeGreaterThanOrEqual(4);
      expect(res.data.pagination.total).toBeGreaterThanOrEqual(4);
    });

    it('should filter users by role', async () => {
      const res = await platformService.listUsers({
        query: { page: 1, limit: 10, role: 'learner' }
      });

      expect(res.data.users).toHaveLength(1);
      expect(res.data.users[0].email).toBe('learner1@example.com');
    });

    it('should filter users by status and exclude soft-deleted users', async () => {
      regularUser.deletedAt = new Date();
      await regularUser.save();

      const res = await platformService.listUsers({
        query: { page: 1, limit: 10, status: 'active' }
      });

      const emails = res.data.users.map(u => u.email);
      expect(emails).not.toContain('learner1@example.com');
    });
  });

  // ==========================================
  // 6. SET BAN STATUS
  // ==========================================
  describe('setBanStatus', () => {
    it('should throw 404 USER_NOT_FOUND if user does not exist', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await expect(
        platformService.setBanStatus({
          targetUserId: fakeId,
          banned: true,
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('User not found');
    });

    it('should throw 400 SELF_ADMIN_CHANGE_DENIED if actor attempts to ban themselves', async () => {
      await expect(
        platformService.setBanStatus({
          targetUserId: platformOwner._id,
          banned: true,
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Platform owners cannot modify their own administrative state');
    });

    it('should throw 403 PLATFORM_OWNER_PROTECTED if target is another platform owner', async () => {
      await expect(
        platformService.setBanStatus({
          targetUserId: otherPlatformOwner._id,
          banned: true,
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Platform owner accounts are protected from user-management actions');
    });

    it('should ban user, revoke all sessions, and log BAN_USER audit action', async () => {
      const res = await platformService.setBanStatus({
        targetUserId: regularUser._id,
        banned: true,
        reason: 'Violated platform policy',
        actor: { id: platformOwner._id.toString() },
        requestMeta: { ip: '127.0.0.1' }
      });

      expect(res.message).toBe('User banned successfully.');
      expect(res.data.user.status).toBe('banned');

      const updated = await User.findById(regularUser._id);
      expect(updated.status).toBe('banned');

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: regularUser._id,
          reason: 'platform_ban'
        })
      );
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'BAN_USER' })
      );
    });

    it('should unban user to active if email is verified, and log UNBAN_USER audit action', async () => {
      regularUser.status = 'banned';
      await regularUser.save();

      const res = await platformService.setBanStatus({
        targetUserId: regularUser._id,
        banned: false,
        reason: 'Appeal approved',
        actor: { id: platformOwner._id.toString() }
      });

      expect(res.message).toBe('User unbanned successfully.');
      expect(res.data.user.status).toBe('active');

      const updated = await User.findById(regularUser._id);
      expect(updated.status).toBe('active');
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'UNBAN_USER' })
      );
    });

    it('should unban user to pending_verification if email is unverified', async () => {
      regularUser.status = 'banned';
      regularUser.emailVerified = false;
      await regularUser.save();

      const res = await platformService.setBanStatus({
        targetUserId: regularUser._id,
        banned: false,
        actor: { id: platformOwner._id.toString() }
      });

      expect(res.data.user.status).toBe('pending_verification');
    });
  });

  // ==========================================
  // 7. CHANGE ROLE
  // ==========================================
  describe('changeRole', () => {
    it('should throw 404 USER_NOT_FOUND if user missing', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await expect(
        platformService.changeRole({
          targetUserId: fakeId,
          role: 'tutor',
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('User not found');
    });

    it('should throw 400 SELF_ADMIN_CHANGE_DENIED if actor attempts to change their own role', async () => {
      await expect(
        platformService.changeRole({
          targetUserId: platformOwner._id,
          role: 'learner',
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Platform owners cannot modify their own administrative state');
    });

    it('should throw 403 PLATFORM_OWNER_PROTECTED if target has platform_owner role', async () => {
      await expect(
        platformService.changeRole({
          targetUserId: otherPlatformOwner._id,
          role: 'learner',
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Platform owner accounts are protected from user-management actions');
    });

    it('should change role to tutor with institutionId, revoke sessions, and log audit', async () => {
      const res = await platformService.changeRole({
        targetUserId: regularUser._id,
        role: 'tutor',
        institutionId: defaultInstitution._id,
        reason: 'Hired as instructor',
        actor: { id: platformOwner._id.toString() },
        requestMeta: { ip: '127.0.0.1' }
      });

      expect(res.message).toBe('User role changed successfully.');
      expect(res.data.user.role).toBe('tutor');

      const updated = await User.findById(regularUser._id);
      expect(updated.role).toBe('tutor');
      expect(updated.institutionId.toString()).toBe(defaultInstitution._id.toString());

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: regularUser._id,
          reason: 'platform_role_changed'
        })
      );
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CHANGE_ROLE',
          metadata: expect.objectContaining({ previousRole: 'learner', nextRole: 'tutor' })
        })
      );
    });

    it('should change role to institution_admin with institutionId', async () => {
      const res = await platformService.changeRole({
        targetUserId: regularUser._id,
        role: 'institution_admin',
        institutionId: defaultInstitution._id,
        actor: { id: platformOwner._id.toString() }
      });

      expect(res.message).toBe('User role changed successfully.');
      expect(res.data.user.role).toBe('institution_admin');

      const updated = await User.findById(regularUser._id);
      expect(updated.role).toBe('institution_admin');
      expect(updated.institutionId.toString()).toBe(defaultInstitution._id.toString());
    });
  });


  // ==========================================
  // 8. SOFT DELETE
  // ==========================================
  describe('softDelete', () => {
    it('should throw 404 USER_NOT_FOUND if user is already deleted or does not exist', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await expect(
        platformService.softDelete({
          targetUserId: fakeId,
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('User not found');
    });

    it('should throw 400 SELF_ADMIN_CHANGE_DENIED if actor attempts to delete themselves', async () => {
      await expect(
        platformService.softDelete({
          targetUserId: platformOwner._id,
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Platform owners cannot modify their own administrative state');
    });

    it('should throw 403 PLATFORM_OWNER_PROTECTED if target has platform_owner role', async () => {
      await expect(
        platformService.softDelete({
          targetUserId: otherPlatformOwner._id,
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Platform owner accounts are protected from user-management actions');
    });

    it('should soft delete user: set deletedAt, set status suspended, revoke sessions, and log audit', async () => {
      const res = await platformService.softDelete({
        targetUserId: regularUser._id,
        actor: { id: platformOwner._id.toString() },
        requestMeta: { ip: '127.0.0.1' }
      });

      expect(res.message).toBe('User deleted successfully.');

      const updated = await User.findById(regularUser._id);
      expect(updated.deletedAt).toBeTruthy();
      expect(updated.status).toBe('suspended');

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: regularUser._id,
          reason: 'platform_soft_delete'
        })
      );
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'SOFT_DELETE_USER' })
      );
    });
  });

  // ==========================================
  // 9. CREATE INSTITUTION
  // ==========================================
  describe('createInstitution', () => {
    it('should throw 400 DOMAIN_ALREADY_EXISTS if domain exists (case-insensitive)', async () => {
      await expect(
        platformService.createInstitution({
          payload: {
            name: 'Another Institute',
            domain: 'APEX-TECH.EDU',
            email: 'unique@apex.edu',
            adminEmail: 'newadmin@apex.edu',
            adminName: 'Admin New'
          },
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Institution domain already exists');
    });

    it('should throw 400 EMAIL_ALREADY_EXISTS if institution email exists', async () => {
      await expect(
        platformService.createInstitution({
          payload: {
            name: 'Another Institute',
            domain: 'unique-domain.edu',
            email: 'CONTACT@APEX-TECH.EDU',
            adminEmail: 'newadmin@apex.edu',
            adminName: 'Admin New'
          },
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Institution email already exists');
    });

    it('should throw 400 CODE_ALREADY_EXISTS if code already exists', async () => {
      await expect(
        platformService.createInstitution({
          payload: {
            name: 'Another Institute',
            domain: 'unique-domain.edu',
            email: 'unique-email@apex.edu',
            code: 'APEX01',
            adminEmail: 'newadmin@apex.edu',
            adminName: 'Admin New'
          },
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Institution code already exists');
    });

    it('should throw 400 USER_ALREADY_EXISTS if admin email already exists in User model', async () => {
      await expect(
        platformService.createInstitution({
          payload: {
            name: 'Another Institute',
            domain: 'unique-domain.edu',
            email: 'unique-email@apex.edu',
            adminEmail: 'learner1@example.com',
            adminName: 'Admin New'
          },
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Admin email already exists as a platform user');
    });

    it('should create institution, admin user, settings, mapping, send email, and log audit', async () => {
      const res = await platformService.createInstitution({
        payload: {
          name: 'Horizon Global University',
          domain: 'horizon.edu',
          email: 'contact@horizon.edu',
          code: 'HGU001',
          description: 'Global Online University',
          adminEmail: 'chancellor@horizon.edu',
          adminName: 'Chancellor Smith'
        },
        actor: { id: platformOwner._id.toString(), _id: platformOwner._id },
        requestMeta: { ip: '127.0.0.1' }
      });

      expect(res.message).toBe('Institution created successfully.');
      expect(res.data.institution.name).toBe('Horizon Global University');
      expect(res.data.admin.email).toBe('chancellor@horizon.edu');

      // Verify DB State
      const createdInst = await Institution.findOne({ domain: 'horizon.edu' });
      expect(createdInst).toBeTruthy();

      const createdAdmin = await User.findOne({ email: 'chancellor@horizon.edu' });
      expect(createdAdmin).toBeTruthy();
      expect(createdAdmin.role).toBe('institution_admin');
      expect(createdAdmin.institutionId.toString()).toBe(createdInst._id.toString());

      const settings = await InstitutionSettings.findOne({ institutionId: createdInst._id });
      expect(settings).toBeTruthy();

      const mapping = await InstitutionAdmin.findOne({ institutionId: createdInst._id, userId: createdAdmin._id });
      expect(mapping).toBeTruthy();

      // Email & Audit
      expect(emailService.sendInstitutionalOnboardingEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'chancellor@horizon.edu',
          institutionName: 'Horizon Global University'
        })
      );
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CREATE_INSTITUTION' })
      );
    });

    it('should not fail institution creation if onboarding email throws an error', async () => {
      emailService.sendInstitutionalOnboardingEmail.mockRejectedValueOnce(new Error('Email server offline'));

      const res = await platformService.createInstitution({
        payload: {
          name: 'Starlight College',
          domain: 'starlight.edu',
          email: 'info@starlight.edu',
          adminEmail: 'dean@starlight.edu',
          adminName: 'Dean Winchester'
        },
        actor: { id: platformOwner._id.toString() }
      });

      expect(res.message).toBe('Institution created successfully.');
      const createdInst = await Institution.findOne({ domain: 'starlight.edu' });
      expect(createdInst).toBeTruthy();
    });

    it('should abort transaction and throw if an error occurs during institution creation', async () => {
      const userCreateSpy = jest.spyOn(User, 'create').mockRejectedValueOnce(new Error('DB creation failed'));

      await expect(
        platformService.createInstitution({
          payload: {
            name: 'Failed Inst',
            domain: 'failed.edu',
            email: 'admin@failed.edu',
            adminEmail: 'super@failed.edu',
            adminName: 'Super Failed'
          },
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('DB creation failed');

      userCreateSpy.mockRestore();
    });
  });

  // ==========================================
  // 10. UPDATE INSTITUTION
  // ==========================================
  describe('updateInstitution', () => {
    it('should throw 404 INSTITUTION_NOT_FOUND if institution does not exist', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await expect(
        platformService.updateInstitution({
          institutionId: fakeId,
          payload: { name: 'Updated' },
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Institution not found');
    });

    it('should throw 400 DOMAIN_ALREADY_EXISTS if updated domain collides with another institution', async () => {
      await Institution.create({
        name: 'Second Inst',
        domain: 'second.edu',
        email: 'second@second.edu',
        owner: regularUser._id
      });

      await expect(
        platformService.updateInstitution({
          institutionId: defaultInstitution._id,
          payload: { domain: 'SECOND.EDU' },
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Institution domain already exists');
    });

    it('should throw 400 EMAIL_ALREADY_EXISTS if updated email collides with another institution', async () => {
      await Institution.create({
        name: 'Third Inst',
        domain: 'third.edu',
        email: 'third@third.edu',
        owner: regularUser._id
      });

      await expect(
        platformService.updateInstitution({
          institutionId: defaultInstitution._id,
          payload: { email: 'THIRD@THIRD.EDU' },
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Institution email already exists');
    });

    it('should throw 400 CODE_ALREADY_EXISTS if updated code collides with another institution', async () => {
      await Institution.create({
        name: 'Fourth Inst',
        domain: 'fourth.edu',
        email: 'fourth@fourth.edu',
        code: 'FOURTH01',
        owner: regularUser._id
      });

      await expect(
        platformService.updateInstitution({
          institutionId: defaultInstitution._id,
          payload: { code: 'FOURTH01' },
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Institution code already exists');
    });

    it('should update institution fields and log UPDATE_INSTITUTION audit', async () => {
      const res = await platformService.updateInstitution({
        institutionId: defaultInstitution._id,
        payload: {
          name: 'Apex Polytechnic',
          description: 'Updated polytechnic institute',
          domain: 'apex-poly.edu',
          email: 'contact@apex-poly.edu',
          code: 'APEX_POLY'
        },
        actor: { id: platformOwner._id.toString() },
        requestMeta: { ip: '127.0.0.1' }
      });

      expect(res.message).toBe('Institution updated successfully.');
      expect(res.data.institution.name).toBe('Apex Polytechnic');
      expect(res.data.institution.domain).toBe('apex-poly.edu');
      expect(res.data.institution.email).toBe('contact@apex-poly.edu');
      expect(res.data.institution.code).toBe('APEX_POLY');

      const updated = await Institution.findById(defaultInstitution._id);
      expect(updated.name).toBe('Apex Polytechnic');
      expect(updated.domain).toBe('apex-poly.edu');
      expect(updated.email).toBe('contact@apex-poly.edu');
      expect(updated.code).toBe('APEX_POLY');
      expect(updated.description).toBe('Updated polytechnic institute');

      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'UPDATE_INSTITUTION' })
      );
    });
  });

  // ==========================================
  // 11. DISABLE INSTITUTION
  // ==========================================
  describe('disableInstitution', () => {
    it('should throw 400 INVALID_STATUS for unrecognized status value', async () => {
      await expect(
        platformService.disableInstitution({
          institutionId: defaultInstitution._id,
          status: 'archived',
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Invalid institution status');
    });

    it('should throw 404 INSTITUTION_NOT_FOUND if institution does not exist', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await expect(
        platformService.disableInstitution({
          institutionId: fakeId,
          status: 'suspended',
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Institution not found');
    });

    it('should suspend institution, suspend all institution_admin users, revoke all user sessions, and log audit', async () => {
      const res = await platformService.disableInstitution({
        institutionId: defaultInstitution._id,
        status: 'suspended',
        actor: { id: platformOwner._id.toString() },
        requestMeta: { ip: '127.0.0.1' }
      });

      expect(res.message).toBe('Institution disabled successfully.');
      expect(res.data.institution.status).toBe('suspended');

      const updatedInst = await Institution.findById(defaultInstitution._id);
      expect(updatedInst.status).toBe('suspended');

      const updatedAdmin = await User.findById(institutionAdmin._id);
      expect(updatedAdmin.status).toBe('suspended');

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: institutionAdmin._id,
          reason: 'institution_suspended'
        })
      );
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'DISABLE_INSTITUTION' })
      );
    });

    it('should reactivate institution and reactivate suspended admins when status is active', async () => {
      defaultInstitution.status = 'suspended';
      await defaultInstitution.save();

      institutionAdmin.status = 'suspended';
      await institutionAdmin.save();

      const res = await platformService.disableInstitution({
        institutionId: defaultInstitution._id,
        status: 'active',
        actor: { id: platformOwner._id.toString() }
      });

      expect(res.message).toBe('Institution enabled successfully.');
      const updatedAdmin = await User.findById(institutionAdmin._id);
      expect(updatedAdmin.status).toBe('active');

      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ENABLE_INSTITUTION' })
      );
    });
  });

  // ==========================================
  // 12. ASSIGN INSTITUTION ADMIN
  // ==========================================
  describe('assignInstitutionAdmin', () => {
    it('should throw 404 INSTITUTION_NOT_FOUND if institution does not exist', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await expect(
        platformService.assignInstitutionAdmin({
          institutionId: fakeId,
          adminEmail: 'newadmin@test.com',
          adminName: 'New Admin',
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Institution not found');
    });

    it('should create new user, assign as institution admin and owner, send email, revoke sessions, and log audit', async () => {
      const res = await platformService.assignInstitutionAdmin({
        institutionId: defaultInstitution._id,
        adminEmail: 'appointed@apex-tech.edu',
        adminName: 'Appointed Administrator',
        actor: { id: platformOwner._id.toString(), _id: platformOwner._id },
        requestMeta: { ip: '127.0.0.1' }
      });

      expect(res.message).toBe('Institution admin assigned successfully.');
      expect(res.data.admin.email).toBe('appointed@apex-tech.edu');

      const createdUser = await User.findOne({ email: 'appointed@apex-tech.edu' });
      expect(createdUser).toBeTruthy();
      expect(createdUser.role).toBe('institution_admin');
      expect(createdUser.institutionId.toString()).toBe(defaultInstitution._id.toString());

      const updatedInst = await Institution.findById(defaultInstitution._id);
      expect(updatedInst.owner.toString()).toBe(createdUser._id.toString());

      const mapping = await InstitutionAdmin.findOne({ institutionId: defaultInstitution._id, userId: createdUser._id });
      expect(mapping).toBeTruthy();

      expect(emailService.sendInstitutionalOnboardingEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'appointed@apex-tech.edu' })
      );
      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(
        expect.objectContaining({ userId: createdUser._id, reason: 'platform_assigned_institution_admin' })
      );
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ASSIGN_INSTITUTION_ADMIN' })
      );
    });

    it('should not fail admin assignment if onboarding email throws an error', async () => {
      emailService.sendInstitutionalOnboardingEmail.mockRejectedValueOnce(new Error('SMTP down'));

      const res = await platformService.assignInstitutionAdmin({
        institutionId: defaultInstitution._id,
        adminEmail: 'appointed2@apex-tech.edu',
        adminName: 'Appointed Administrator 2',
        actor: { id: platformOwner._id.toString(), _id: platformOwner._id }
      });

      expect(res.message).toBe('Institution admin assigned successfully.');
      const createdUser = await User.findOne({ email: 'appointed2@apex-tech.edu' });
      expect(createdUser).toBeTruthy();
    });

    it('should promote existing user to institution_admin, update owner, and upsert mapping', async () => {
      const res = await platformService.assignInstitutionAdmin({
        institutionId: defaultInstitution._id,
        adminEmail: 'learner1@example.com',
        adminName: 'Learner One',
        actor: { id: platformOwner._id.toString() }
      });

      expect(res.message).toBe('Institution admin assigned successfully.');
      const promotedUser = await User.findById(regularUser._id);
      expect(promotedUser.role).toBe('institution_admin');
      expect(promotedUser.institutionId.toString()).toBe(defaultInstitution._id.toString());

      const updatedInst = await Institution.findById(defaultInstitution._id);
      expect(updatedInst.owner.toString()).toBe(promotedUser._id.toString());
      expect(emailService.sendInstitutionalOnboardingEmail).not.toHaveBeenCalled();
    });

    it('should promote an inactive/suspended existing user and activate their status', async () => {
      regularUser.status = 'suspended';
      await regularUser.save();

      const res = await platformService.assignInstitutionAdmin({
        institutionId: defaultInstitution._id,
        adminEmail: 'learner1@example.com',
        adminName: 'Learner One',
        actor: { id: platformOwner._id.toString() }
      });

      expect(res.message).toBe('Institution admin assigned successfully.');
      const activatedUser = await User.findById(regularUser._id);
      expect(activatedUser.status).toBe('active');
      expect(activatedUser.role).toBe('institution_admin');
    });

    it('should abort transaction and throw if an error occurs during admin assignment', async () => {
      const instFindSpy = jest.spyOn(InstitutionAdmin, 'findOneAndUpdate').mockRejectedValueOnce(new Error('Admin mapping failed'));

      await expect(
        platformService.assignInstitutionAdmin({
          institutionId: defaultInstitution._id,
          adminEmail: 'learner1@example.com',
          adminName: 'Learner One',
          actor: { id: platformOwner._id.toString() }
        })
      ).rejects.toThrow('Admin mapping failed');

      instFindSpy.mockRestore();
    });
  });

  // ==========================================
  // 13. GET INSTITUTION STATS
  // ==========================================
  describe('getInstitutionStats', () => {
    it('should throw 404 INSTITUTION_NOT_FOUND if institution missing', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await expect(
        platformService.getInstitutionStats({ institutionId: fakeId })
      ).rejects.toThrow('Institution not found');
    });

    it('should return accurate counts for learners, tutors, courses, and active batches', async () => {
      // Create Tutor
      await User.create({
        name: 'Apex Tutor',
        email: 'tutor@apex.edu',
        passwordHash: 'dummy',
        role: 'tutor',
        institutionId: defaultInstitution._id,
        status: 'active'
      });

      // Create Learner
      await User.create({
        name: 'Apex Learner',
        email: 'learner@apex.edu',
        passwordHash: 'dummy',
        role: 'learner',
        institutionId: defaultInstitution._id,
        status: 'active'
      });

      // Create Course
      await Course.create({
        title: 'Algorithms 101',
        description: 'Computer science course',
        category: 'Computer Science',
        level: 'Beginner',
        authorId: institutionAdmin._id,
        institutionId: defaultInstitution._id
      });

      // Create Batch
      await Batch.create({
        name: 'Batch 2026',
        institutionId: defaultInstitution._id,
        status: 'active',
        createdBy: institutionAdmin._id,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      });

      const res = await platformService.getInstitutionStats({
        institutionId: defaultInstitution._id
      });

      expect(res.message).toBe('Institution stats retrieved successfully.');
      expect(res.data.learnerCount).toBe(1);
      expect(res.data.tutorCount).toBe(1);
      expect(res.data.courseCount).toBe(1);
      expect(res.data.activeBatchCount).toBe(1);
    });
  });

  // ==========================================
  // 14. LIST INSTITUTIONS
  // ==========================================
  describe('listInstitutions', () => {
    it('should return paginated list of institutions with populated owner', async () => {
      const res = await platformService.listInstitutions({
        query: { page: 1, limit: 10 }
      });

      expect(res.message).toBe('Institutions retrieved successfully.');
      expect(res.data.institutions).toHaveLength(1);
      expect(res.data.institutions[0].owner.email).toBe('instadmin@example.com');
      expect(res.data.pagination.total).toBe(1);
    });

    it('should filter institutions by status', async () => {
      const res = await platformService.listInstitutions({
        query: { page: 1, limit: 10, status: 'suspended' }
      });
      expect(res.data.institutions).toHaveLength(0);
    });

    it('should search institutions by name (case-insensitive regex)', async () => {
      const res = await platformService.listInstitutions({
        query: { page: 1, limit: 10, search: 'apex' }
      });
      expect(res.data.institutions).toHaveLength(1);
      expect(res.data.institutions[0].name).toBe('Apex Institute of Technology');
    });

    it('should search institutions by domain', async () => {
      const res = await platformService.listInstitutions({
        query: { page: 1, limit: 10, search: 'apex-tech' }
      });
      expect(res.data.institutions).toHaveLength(1);
    });
  });

  // ==========================================
  // 15. GET DASHBOARD STATS
  // ==========================================
  describe('getDashboardStats', () => {
    it('should aggregate platform KPIs, signup series, top courses, recent activities, and user distribution', async () => {
      const now = new Date();

      // Create Course
      const course = await Course.create({
        title: 'Mastering Node.js',
        description: 'Comprehensive backend engineering',
        category: 'Software Engineering',
        level: 'Advanced',
        authorId: institutionAdmin._id
      });

      // Create Enrollment
      await Enrollment.create({
        userId: regularUser._id,
        courseId: course._id,
        enrollmentType: 'paid',
        status: 'active'
      });

      // Create Progress today
      await Progress.create({
        userId: regularUser._id,
        courseId: course._id,
        totalLessons: 10,
        completedLessons: [new mongoose.Types.ObjectId()],
        percentComplete: 10,
        updatedAt: now
      });

      // Create Payment
      await Payment.create({
        learnerId: regularUser._id,
        courseId: course._id,
        amount: 2500,
        currency: 'INR',
        transactionId: 'txn_dash_001',
        paymentStatus: 'success',
        paidAt: now
      });

      const res = await platformService.getDashboardStats();

      expect(res.message).toBe('Platform dashboard stats retrieved successfully.');
      expect(res.data.kpis).toHaveLength(4);

      // Total users KPI
      const usersKpi = res.data.kpis.find(k => k.key === 'totalUsers');
      expect(usersKpi.value).toBeGreaterThanOrEqual(4);

      // Total courses KPI
      const coursesKpi = res.data.kpis.find(k => k.key === 'totalCourses');
      expect(coursesKpi.value).toBeGreaterThanOrEqual(1);

      // Revenue MTD KPI
      const revKpi = res.data.kpis.find(k => k.key === 'revenueMtd');
      expect(revKpi.value).toBe(2500);

      // Active learners today KPI
      const activeKpi = res.data.kpis.find(k => k.key === 'activeLearnersToday');
      expect(activeKpi.value).toBe(1);

      // 14-day signup series
      expect(res.data.signupSeries).toHaveLength(14);
      expect(res.data.signupSeries[13]).toHaveProperty('date');
      expect(res.data.signupSeries[13]).toHaveProperty('value');

      // Top courses
      expect(res.data.enrollmentTopCourses).toHaveLength(1);
      expect(res.data.enrollmentTopCourses[0].title).toBe('Mastering Node.js');
      expect(res.data.enrollmentTopCourses[0].enrollments).toBe(1);

      // Recent activities
      expect(res.data.recentActivities.length).toBeGreaterThanOrEqual(1);

      // User distribution
      expect(res.data.userDistribution.learners).toBe(1);
      expect(res.data.userDistribution.admins).toBeGreaterThanOrEqual(3);
    });

    it('should handle zero records gracefully with default empty values', async () => {
      // Clear collections for clean zero test
      await clearDB();

      const res = await platformService.getDashboardStats();

      expect(res.message).toBe('Platform dashboard stats retrieved successfully.');
      const usersKpi = res.data.kpis.find(k => k.key === 'totalUsers');
      expect(usersKpi.value).toBe(0);

      const revKpi = res.data.kpis.find(k => k.key === 'revenueMtd');
      expect(revKpi.value).toBe(0);

      expect(res.data.enrollmentTopCourses).toEqual([]);
      expect(res.data.recentActivities).toEqual([]);
      expect(res.data.userDistribution.total).toBe(0);
    });

    it('should compute positive and negative percentChange when previous period data exists', async () => {
      await clearDB();
      const now = new Date();
      const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 15);

      // Create previous month user
      const prevUser = await User.create({
        name: 'Old User',
        email: 'old@example.com',
        passwordHash: 'dummy',
        role: 'learner',
        createdAt: prevMonthDate
      });

      // Create previous month payment (amount = 4000)
      await Payment.create({
        learnerId: prevUser._id,
        amount: 4000,
        currency: 'INR',
        transactionId: 'txn_prev_001',
        paymentStatus: 'success',
        paidAt: prevMonthDate
      });

      // Create current month payment (amount = 2000, so revenue declined: -50.0%)
      await Payment.create({
        learnerId: prevUser._id,
        amount: 2000,
        currency: 'INR',
        transactionId: 'txn_curr_001',
        paymentStatus: 'success',
        paidAt: now
      });

      const res = await platformService.getDashboardStats();

      const revKpi = res.data.kpis.find(k => k.key === 'revenueMtd');
      expect(revKpi.value).toBe(2000);
      expect(revKpi.change).toBe('-50.0% vs last month');
    });
  });
});
