const { createAccessToken } = require('../../src/utils/tokens');
const { buildUser } = require('../fixtures/user.fixture');

const getAuthHeaders = (userOverrides = {}) => {
  const user = buildUser(userOverrides);
  const token = createAccessToken(user);
  return {
    Authorization: `Bearer ${token}`,
    user
  };
};

const getRoleAuthHeaders = (role = 'learner', overrides = {}) => {
  return getAuthHeaders({
    role,
    ...overrides
  });
};

module.exports = {
  getAuthHeaders,
  getRoleAuthHeaders
};
