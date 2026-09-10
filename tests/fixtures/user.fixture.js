const bcrypt = require('bcrypt');
const mongoose = require('mongoose');

const buildUser = (overrides = {}) => {
  const defaultPassword = 'Password123!';
  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(defaultPassword, salt);

  return {
    _id: new mongoose.Types.ObjectId(),
    name: 'Test Learner',
    email: `test_${Date.now()}@example.com`,
    passwordHash,
    role: 'learner',
    accountType: 'individual_learner',
    status: 'active',
    emailVerified: true,
    ...overrides
  };
};

const buildCourse = (instructorId, overrides = {}) => {
  return {
    _id: new mongoose.Types.ObjectId(),
    title: 'Comprehensive MERN Testing Course',
    slug: `mern-testing-course-${Date.now()}`,
    description: 'Master fullstack automated testing with Jest, Vitest, and Playwright.',
    authorId: instructorId,
    category: 'Development',
    level: 'Intermediate',
    price: 49.99,
    status: 'published',
    visibility: 'public',
    ...overrides
  };
};

module.exports = {
  buildUser,
  buildCourse
};
