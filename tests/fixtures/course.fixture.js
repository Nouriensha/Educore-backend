const mongoose = require('mongoose');

const buildCourse = (authorId, overrides = {}) => {
  const uniqueId = Date.now() + Math.floor(Math.random() * 1000);
  return {
    _id: new mongoose.Types.ObjectId(),
    title: `Test Course ${uniqueId}`,
    slug: `test-course-${uniqueId}`,
    description: 'Comprehensive test course for EduCore backend automation testing.',
    authorId: authorId || new mongoose.Types.ObjectId(),
    category: 'Development',
    level: 'Beginner',
    price: 49.99,
    status: 'published',
    visibility: 'public',
    isApproved: true,
    ...overrides
  };
};

module.exports = {
  buildCourse
};
