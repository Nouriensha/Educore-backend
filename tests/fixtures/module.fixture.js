const mongoose = require('mongoose');

const buildModule = (courseId, overrides = {}) => {
  return {
    _id: new mongoose.Types.ObjectId(),
    courseId: courseId || new mongoose.Types.ObjectId(),
    title: 'Introduction to Module',
    description: 'Overview and setup for the course module.',
    order: 1,
    isPublished: true,
    ...overrides
  };
};

module.exports = {
  buildModule
};
