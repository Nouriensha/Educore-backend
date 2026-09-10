const { authenticate } = require('../../../src/middlewares/auth.middleware');
const { createAccessToken } = require('../../../src/utils/tokens');
const User = require('../../../src/models/user.model');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { buildUser } = require('../../fixtures/user.fixture');

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
});
