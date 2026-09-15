const mongoose = require('mongoose');
const {
  authenticate,
  optionalAuthenticate,
  authenticateTutorApproval,
  authenticatePlatformOwner
} = require('../../../src/middlewares/auth.middleware');
const { createAccessToken } = require('../../../src/utils/tokens');
const User = require('../../../src/models/user.model');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { buildUser } = require('../../fixtures/user.fixture');
const { getExpiredAuthHeaders } = require('../../helpers/auth.helper');

describe('Auth Middleware Unit & Integration Tests', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  describe('authenticate', () => {
    test('should return 401 AUTH_REQUIRED if no authorization header or cookie is present', async () => {
      const req = { get: jest.fn().mockReturnValue(null), cookies: {} };
      const res = {};

      const error = await new Promise((resolve) => {
        authenticate(req, res, (err) => resolve(err));
      });

      expect(error).toBeDefined();
      expect(error.statusCode).toBe(401);
      expect(error.code).toBe('AUTH_REQUIRED');
    });

    test('should return 401 ACCESS_TOKEN_INVALID if token signature is malformed', async () => {
      const req = { get: jest.fn().mockReturnValue('Bearer invalid_token_xyz'), cookies: {} };
      const res = {};

      const error = await new Promise((resolve) => {
        authenticate(req, res, (err) => resolve(err));
      });

      expect(error).toBeDefined();
      expect(error.statusCode).toBe(401);
      expect(error.code).toBe('ACCESS_TOKEN_INVALID');
    });

    test('should return 401 ACCESS_TOKEN_EXPIRED for an expired token', async () => {
      const expiredData = getExpiredAuthHeaders();
      const req = { get: jest.fn().mockReturnValue(expiredData.headers.Authorization), cookies: {} };
      const res = {};

      const error = await new Promise((resolve) => {
        authenticate(req, res, (err) => resolve(err));
      });

      expect(error).toBeDefined();
      expect(error.statusCode).toBe(401);
      expect(error.code).toBe('ACCESS_TOKEN_EXPIRED');
    });

    test('should return 403 EMAIL_VERIFICATION_REQUIRED if user email is unverified', async () => {
      const dbUser = await new User(buildUser({ emailVerified: false, status: 'active' })).save();
      const token = createAccessToken(dbUser);
      const req = { get: jest.fn().mockReturnValue(`Bearer ${token}`), cookies: {} };
      const res = {};

      const error = await new Promise((resolve) => {
        authenticate(req, res, (err) => resolve(err));
      });

      expect(error).toBeDefined();
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('EMAIL_VERIFICATION_REQUIRED');
    });

    test('should return 403 ACCOUNT_NOT_ACTIVE if user is banned or suspended', async () => {
      const dbUser = await new User(buildUser({ emailVerified: true, status: 'banned' })).save();
      const token = createAccessToken(dbUser);
      const req = { get: jest.fn().mockReturnValue(`Bearer ${token}`), cookies: {} };
      const res = {};

      const error = await new Promise((resolve) => {
        authenticate(req, res, (err) => resolve(err));
      });

      expect(error).toBeDefined();
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('ACCOUNT_NOT_ACTIVE');
    });

    test('should attach user payload to req.user and call next() for valid bearer token', async () => {
      const dbUser = await new User(buildUser({ email: 'activeuser@example.com', status: 'active', emailVerified: true })).save();
      const token = createAccessToken(dbUser);

      const req = {
        get: jest.fn().mockReturnValue(`Bearer ${token}`),
        cookies: {}
      };
      const res = {};

      await new Promise((resolve) => {
        authenticate(req, res, () => resolve());
      });

      expect(req.user).toBeDefined();
      expect(req.user.id).toBe(dbUser._id.toString());
      expect(req.user.email).toBe('activeuser@example.com');
    });

    test('should authenticate user via req.cookies.accessToken if no Auth header is present', async () => {
      const dbUser = await new User(buildUser({ email: 'cookieuser@example.com', status: 'active', emailVerified: true })).save();
      const token = createAccessToken(dbUser);

      const req = {
        get: jest.fn().mockReturnValue(null),
        cookies: { accessToken: token }
      };
      const res = {};

      await new Promise((resolve) => {
        authenticate(req, res, () => resolve());
      });

      expect(req.user).toBeDefined();
      expect(req.user.email).toBe('cookieuser@example.com');
    });

    test('should return 401 USER_NOT_FOUND if token user does not exist in database', async () => {
      const nonExistentUserId = new mongoose.Types.ObjectId();
      const token = createAccessToken({ _id: nonExistentUserId, role: 'learner' });

      const req = {
        get: jest.fn().mockReturnValue(`Bearer ${token}`),
        cookies: {}
      };
      const res = {};

      const error = await new Promise((resolve) => {
        authenticate(req, res, (err) => resolve(err));
      });

      expect(error).toBeDefined();
      expect(error.statusCode).toBe(401);
      expect(error.code).toBe('USER_NOT_FOUND');
    });
  });

  describe('authenticateTutorApproval', () => {
    test('should reject non-tutor users with 403 TUTOR_ACCOUNT_REQUIRED', async () => {
      const learnerUser = await new User(buildUser({ role: 'learner', status: 'pending_approval', emailVerified: true })).save();
      const token = createAccessToken(learnerUser);
      const req = { get: jest.fn().mockReturnValue(`Bearer ${token}`), cookies: {} };
      const res = {};

      const error = await new Promise((resolve) => {
        authenticateTutorApproval(req, res, (err) => resolve(err));
      });

      expect(error).toBeDefined();
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('TUTOR_ACCOUNT_REQUIRED');
    });

    test('should reject already active tutors with 403 ACCOUNT_NOT_ELIGIBLE', async () => {
      const activeTutor = await new User(buildUser({ role: 'tutor', status: 'active', emailVerified: true })).save();
      const token = createAccessToken(activeTutor);
      const req = { get: jest.fn().mockReturnValue(`Bearer ${token}`), cookies: {} };
      const res = {};

      const error = await new Promise((resolve) => {
        authenticateTutorApproval(req, res, (err) => resolve(err));
      });

      expect(error).toBeDefined();
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('ACCOUNT_NOT_ELIGIBLE');
    });

    test('should allow pending_approval tutor users', async () => {
      const pendingTutor = await new User(buildUser({ role: 'tutor', status: 'pending_approval', emailVerified: true })).save();
      const token = createAccessToken(pendingTutor);
      const req = { get: jest.fn().mockReturnValue(`Bearer ${token}`), cookies: {} };
      const res = {};

      await new Promise((resolve) => {
        authenticateTutorApproval(req, res, () => resolve());
      });

      expect(req.user).toBeDefined();
      expect(req.user.id).toBe(pendingTutor._id.toString());
      expect(req.user.role).toBe('tutor');
    });
  });

  describe('optionalAuthenticate', () => {
    test('should proceed without req.user if no token provided', async () => {
      const req = { get: jest.fn().mockReturnValue(null), cookies: {} };
      const res = {};
      const next = jest.fn();

      await optionalAuthenticate(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.user).toBeUndefined();
    });

    test('should attach req.user when valid token is provided', async () => {
      const dbUser = await new User(buildUser({ status: 'active', emailVerified: true })).save();
      const token = createAccessToken(dbUser);
      const req = { get: jest.fn().mockReturnValue(`Bearer ${token}`), cookies: {} };
      const res = {};
      const next = jest.fn();

      await optionalAuthenticate(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.user).toBeDefined();
      expect(req.user.id).toBe(dbUser._id.toString());
    });
  });

  describe('authenticatePlatformOwner', () => {
    test('should reject non-platform admin roles with 401 ACCESS_TOKEN_INVALID', async () => {
      const learnerUser = await new User(buildUser({ role: 'learner', status: 'active', emailVerified: true })).save();
      const token = createAccessToken(learnerUser);
      const req = { get: jest.fn().mockReturnValue(`Bearer ${token}`), cookies: {} };
      const res = {};

      const error = await new Promise((resolve) => {
        authenticatePlatformOwner(req, res, (err) => resolve(err));
      });

      expect(error).toBeDefined();
      expect(error.statusCode).toBe(401);
      expect(error.code).toBe('ACCESS_TOKEN_INVALID');
    });

    test('should allow platform_owner role and attach isPlatformOwner: true', async () => {
      const ownerUser = await new User(buildUser({ role: 'platform_owner', status: 'active', emailVerified: true })).save();
      const token = createAccessToken(ownerUser);
      const req = { get: jest.fn().mockReturnValue(`Bearer ${token}`), cookies: {} };
      const res = {};

      await new Promise((resolve) => {
        authenticatePlatformOwner(req, res, () => resolve());
      });

      expect(req.user).toBeDefined();
      expect(req.user.isPlatformOwner).toBe(true);
      expect(req.user.isPlatformAdmin).toBe(true);
    });
  });
});
