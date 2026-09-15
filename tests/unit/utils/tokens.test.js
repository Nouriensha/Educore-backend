const mongoose = require('mongoose');
const {
  createAccessToken,
  createRefreshToken,
  verifyAccessToken,
  verifyRefreshToken
} = require('../../../src/utils/tokens');
const { buildUser } = require('../../fixtures/user.fixture');

describe('Tokens Utility Unit Tests', () => {
  const sampleUser = buildUser({
    _id: new mongoose.Types.ObjectId(),
    role: 'learner',
    accountType: 'individual_learner'
  });

  test('should create and verify valid access token', () => {
    const token = createAccessToken(sampleUser);
    expect(token).toBeDefined();

    const decoded = verifyAccessToken(token);
    expect(decoded.sub).toBe(String(sampleUser._id));
    expect(decoded.role).toBe('learner');
    expect(decoded.type).toBe('access');
  });

  test('should create and verify valid refresh token', () => {
    const { token, tokenHash, expiresAt } = createRefreshToken(sampleUser, true);
    expect(token).toBeDefined();
    expect(tokenHash).toBeDefined();
    expect(expiresAt).toBeInstanceOf(Date);

    const decoded = verifyRefreshToken(token);
    expect(decoded.sub).toBe(String(sampleUser._id));
    expect(decoded.type).toBe('refresh');
    expect(decoded.jti).toBeDefined();
  });

  test('should throw error when verifying invalid token signature', () => {
    const invalidToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid.payload';
    expect(() => verifyAccessToken(invalidToken)).toThrow();
  });
});
