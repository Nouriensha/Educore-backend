const mongoose = require('mongoose');
const authService = require('../../../src/services/auth.service');
const User = require('../../../src/models/user.model');
const RefreshToken = require('../../../src/models/refreshToken.model');
const redis = require('../../../src/config/redis');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { ApiError } = require('../../../src/utils/errors');
const { buildUser } = require('../../fixtures/user.fixture');

jest.mock('../../../src/services/email.service', () => ({
  sendMail: jest.fn().mockResolvedValue({ messageId: 'mock-email-id-123' }),
  sendOtpEmail: jest.fn().mockResolvedValue(true),
  sendTutorApprovalRequestEmail: jest.fn().mockResolvedValue(true),
  sendCertificateEmail: jest.fn().mockResolvedValue(true),
  sendWelcomeEmail: jest.fn().mockResolvedValue(true),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true)
}));

describe('Auth Service Unit Tests', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterEach(async () => {
    await clearDB();
    await redis.flushall();
  });

  afterAll(async () => {
    await closeDB();
  });

  describe('register', () => {
    test('should successfully register learner and store pending data in Redis', async () => {
      const payload = {
        fullName: 'John Learner',
        email: 'johnlearner@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
        registrationType: 'individual_learner'
      };

      const res = await authService.register({ payload });
      expect(res.message).toContain('Registration successful');

      const redisKey = `pending-registration:johnlearner@example.com`;
      const raw = await redis.get(redisKey);
      expect(raw).toBeDefined();

      const data = JSON.parse(raw);
      expect(data.fullName).toBe('John Learner');
      expect(data.otp).toBeDefined();
    });

    test('should throw 409 EMAIL_ALREADY_EXISTS for duplicate active email', async () => {
      await new User(buildUser({ email: 'duplicate@example.com', status: 'active' })).save();

      const payload = {
        fullName: 'Dup User',
        email: 'duplicate@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
        registrationType: 'individual_learner'
      };

      await expect(authService.register({ payload })).rejects.toThrow(ApiError);
    });

    test('should throw 409 REGISTRATION_ALREADY_PENDING if pending key exists', async () => {
      const email = 'pendingdup@example.com';
      await redis.set(`pending-registration:${email}`, JSON.stringify({ email }));

      const payload = {
        fullName: 'Pending Dup',
        email,
        password: 'Password123!',
        confirmPassword: 'Password123!',
        registrationType: 'individual_learner'
      };

      let err;
      try {
        await authService.register({ payload });
      } catch (e) {
        err = e;
      }

      expect(err).toBeDefined();
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('REGISTRATION_ALREADY_PENDING');
    });
  });

  describe('login & account locking', () => {
    test('should lock account after max failed login attempts', async () => {
      const email = 'locktest@example.com';
      const password = 'Password123!';
      const user = await new User(buildUser({ email, status: 'active', emailVerified: true })).save();

      // Trigger 5 failed login attempts
      for (let i = 0; i < 5; i++) {
        try {
          await authService.login({ payload: { email, password: 'WrongPassword!' } });
        } catch (_err) {}
      }

      const updatedUser = await User.findById(user._id);
      expect(updatedUser.failedLoginAttempts).toBeGreaterThanOrEqual(5);
      expect(updatedUser.lockUntil).toBeDefined();
    });

    test('should reject locked account immediately with 423 ACCOUNT_LOCKED', async () => {
      const email = 'locked@example.com';
      const lockUntil = new Date(Date.now() + 15 * 60 * 1000);
      await new User(buildUser({ email, status: 'active', emailVerified: true, lockUntil })).save();

      let err;
      try {
        await authService.login({ payload: { email, password: 'Password123!' } });
      } catch (e) {
        err = e;
      }

      expect(err).toBeDefined();
      expect(err.statusCode).toBe(423);
      expect(err.code).toBe('ACCOUNT_LOCKED');
    });

    test('should reject unverified email with 403 EMAIL_VERIFICATION_REQUIRED', async () => {
      const email = 'unverified@example.com';
      await new User(buildUser({ email, status: 'active', emailVerified: false })).save();

      let err;
      try {
        await authService.login({ payload: { email, password: 'Password123!' } });
      } catch (e) {
        err = e;
      }

      expect(err).toBeDefined();
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe('EMAIL_VERIFICATION_REQUIRED');
    });
  });
});
