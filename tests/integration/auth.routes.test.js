const request = require('supertest');
const app = require('../../src/app');
const User = require('../../src/models/user.model');
const { connectDB, closeDB, clearDB } = require('../setup/test-db');
const { buildUser } = require('../fixtures/user.fixture');

describe('Auth API Routes Integration Tests', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterEach(async () => {
    await clearDB();
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
    });

    test('should return 409 Conflict when registering with duplicate email', async () => {
      await new User(buildUser({ email: 'existing@example.com' })).save();

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
    });

    test('should return 400 when registration payload fails validation (missing email/password)', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ fullName: 'Incomplete' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
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
    });
  });
});
