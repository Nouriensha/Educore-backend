const mongoose = require('mongoose');

const buildLesson = (courseId, moduleId, overrides = {}) => {
  return {
    _id: new mongoose.Types.ObjectId(),
    courseId: courseId || new mongoose.Types.ObjectId(),
    moduleId: moduleId || new mongoose.Types.ObjectId(),
    title: 'Lesson 1: Getting Started',
    description: 'Detailed lesson explanation.',
    type: 'video',
    videoUrl: 'https://example.com/video.mp4',
    duration: 300,
    order: 1,
    isPreview: false,
    isPublished: true,
    ...overrides
  };
};

module.exports = {
  buildLesson
};
