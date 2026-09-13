const mongoose = require('mongoose');

const buildEnrollment = (userId, courseId, overrides = {}) => {
  return {
    _id: new mongoose.Types.ObjectId(),
    userId: userId || new mongoose.Types.ObjectId(),
    courseId: courseId || new mongoose.Types.ObjectId(),
    status: 'active',
    enrolledAt: new Date(),
    progress: 0,
    completedLessons: [],
    ...overrides
  };
};

module.exports = {
  buildEnrollment
};
