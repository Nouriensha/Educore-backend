const jwt = require('jsonwebtoken');
const env = require('../../src/config/env');
const { createAccessToken } = require('../../src/utils/tokens');
const { buildUser } = require('../fixtures/user.fixture');
const User = require('../../src/models/user.model');

const createTestUser = async (overrides = {}) => {
  const userData = buildUser(overrides);
  return await User.create(userData);
};

const getAuthHeaders = (userOverrides = {}) => {
  const user = buildUser(userOverrides);
  const token = createAccessToken(user);
  return {
    headers: {
      Authorization: `Bearer ${token}`
    },
    token,
    user
  };
};

const getRoleAuthHeaders = (role = 'learner', overrides = {}) => {
  return getAuthHeaders({
    role,
    ...overrides
  });
};

const getInvalidAuthHeaders = () => {
  return {
    headers: {
      Authorization: 'Bearer invalid.token.signature'
    }
  };
};

const getExpiredAuthHeaders = (userOverrides = {}) => {
  const user = buildUser(userOverrides);
  const tokenPayload = {
    sub: String(user._id),
    role: user.role,
    accountType: user.accountType,
    institutionId: user.institutionId ? String(user.institutionId) : null,
    tenant: 'individual',
    type: 'access'
  };
  
  const expiredToken = jwt.sign(tokenPayload, env.jwt.accessSecret, {
    expiresIn: '-10s',
    issuer: env.jwt.issuer,
    audience: env.jwt.audience
  });

  return {
    headers: {
      Authorization: `Bearer ${expiredToken}`
    },
    token: expiredToken,
    user
  };
};

module.exports = {
  createTestUser,
  getAuthHeaders,
  getRoleAuthHeaders,
  getInvalidAuthHeaders,
  getExpiredAuthHeaders
};
