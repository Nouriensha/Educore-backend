const request = require('supertest');
const app = require('../../src/app');
const User = require('../../src/models/user.model');
const redis = require('../../src/config/redis');
const { connectDB, closeDB, clearDB } = require('../setup/test-db');
const { buildUser } = require('../fixtures/user.fixture');
const { getAuthHeaders } = require('../helpers/auth.helper');

describe('Auth API Routes Integration Tests', () => {
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

  describe('GET /health', () => {
    test('should return 200 OK with health status information', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('healthy');
      expect(res.body.data.status).toBe('ok');
    });
  });

  describe('POST /api/v1/auth/register', () => {
    test('should register a new learner user successfully', async () => {
      const payload = {
        registrationType: 'individual_learner',
        fullName: 'Jane Doe',
        email: 'janedoe@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!'
      };

      const res = await request(app)
        .post('/api/v1/auth/register')
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('Registration successful');
    });

    test('should return 409 Conflict when registering with duplicate email', async () => {
      await new User(buildUser({ email: 'existing@example.com', status: 'active' })).save();

      const payload = {
        registrationType: 'individual_learner',
        fullName: 'Another User',
        email: 'existing@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!'
      };

      const res = await request(app)
        .post('/api/v1/auth/register')
        .send(payload);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('EMAIL_ALREADY_EXISTS');
    });

    test('should return 400 when registration payload fails validation (missing email/password)', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ fullName: 'Incomplete' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('POST /api/v1/auth/verify-email', () => {
    test('should return 400 REGISTRATION_EXPIRED for non-existent pending registration', async () => {
      const res = await request(app)
        .post('/api/v1/auth/verify-email')
        .send({
          email: 'nonexistent@example.com',
          otp: '123456'
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('REGISTRATION_EXPIRED');
    });
  });

  describe('POST /api/v1/auth/resend-otp', () => {
    test('should return 400 REGISTRATION_EXPIRED if no pending registration exists', async () => {
      const res = await request(app)
        .post('/api/v1/auth/resend-otp')
        .send({
          email: 'no-pending@example.com'
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('REGISTRATION_EXPIRED');
    });
  });

  describe('POST /api/v1/auth/login', () => {
    test('should successfully log in active user with valid credentials', async () => {
      const user = buildUser({
        email: 'loginuser@example.com',
        status: 'active',
        emailVerified: true
      });
      await new User(user).save();

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'loginuser@example.com',
          password: 'Password123!'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.user.passwordHash).toBeUndefined(); // Response sanitization check
    });

    test('should return 401 for invalid password', async () => {
      await new User(buildUser({ email: 'user@example.com', status: 'active', emailVerified: true })).save();

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'user@example.com',
          password: 'WrongPassword123!'
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('POST /api/v1/auth/forgot-password', () => {
    test('should return 200 success message regardless of whether email exists', async () => {
      const res = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'unknown@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('If the email exists');
    });
  });

  describe('POST /api/v1/auth/reset-password', () => {
    test('should return 400 for invalid or expired reset token', async () => {
      const res = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({
          token: '1234567890123456789012345678901234567890',
          password: 'NewPassword123!',
          confirmPassword: 'NewPassword123!'
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('RESET_TOKEN_INVALID');
    });
  });

  describe('POST /api/v1/auth/refresh-token', () => {
    test('should return 401 REFRESH_TOKEN_INVALID for invalid refresh token', async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh-token')
        .send({ refreshToken: 'invalid.refresh.token' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('REFRESH_TOKEN_INVALID');
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    test('should return 200 OK for logout request', async () => {
      const res = await request(app)
        .post('/api/v1/auth/logout')
        .send({ refreshToken: 'some.refresh.token' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('User Profile & Authentication (/api/v1/users)', () => {
    test('GET /api/v1/users/me should return 401 when unauthenticated', async () => {
      const res = await request(app).get('/api/v1/users/me');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_REQUIRED');
    });

    test('GET /api/v1/users/me should return 200 and user profile when authenticated', async () => {
      const dbUser = await new User(buildUser({ email: 'profileuser@example.com', status: 'active', emailVerified: true })).save();
      const auth = getAuthHeaders({ _id: dbUser._id, role: dbUser.role });

      const res = await request(app)
        .get('/api/v1/users/me')
        .set(auth.headers);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email).toBe('profileuser@example.com');
      expect(res.body.data.user.passwordHash).toBeUndefined(); // Sensitive data leakage check
    });
  });
});
