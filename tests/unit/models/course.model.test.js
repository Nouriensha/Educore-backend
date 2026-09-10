const Course = require('../../../src/models/course.model');
const mongoose = require('mongoose');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');

describe('Course Model Schema & Validation Unit Tests', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  test('should successfully create & save a valid course', async () => {
    const authorId = new mongoose.Types.ObjectId();
    const courseData = {
      title: 'Fullstack Node.js & React Mastery',
      description: 'Learn modern fullstack web development from scratch.',
      category: 'Web Development',
      level: 'Beginner',
      authorId
    };

    const course = new Course(courseData);
    const savedCourse = await course.save();

    expect(savedCourse._id).toBeDefined();
    expect(savedCourse.title).toBe('Fullstack Node.js & React Mastery');
    expect(savedCourse.status).toBe('draft');
    expect(savedCourse.courseType).toBe('PUBLIC');
    expect(savedCourse.isFree).toBe(true);
  });

  test('should set courseType to INSTITUTION if institutionId is provided', async () => {
    const authorId = new mongoose.Types.ObjectId();
    const institutionId = new mongoose.Types.ObjectId();
    const courseData = {
      title: 'Institutional React Course',
      description: 'Exclusive course for enrolled students.',
      category: 'Computer Science',
      authorId,
      institutionId
    };

    const course = await new Course(courseData).save();
    expect(course.courseType).toBe('INSTITUTION');
  });

  test('should fail validation if required fields (title, description, category, authorId) are missing', async () => {
    const invalidCourse = new Course({});
    let err;
    try {
      await invalidCourse.save();
    } catch (error) {
      err = error;
    }
    expect(err).toBeDefined();
    expect(err.errors.title).toBeDefined();
    expect(err.errors.description).toBeDefined();
    expect(err.errors.category).toBeDefined();
    expect(err.errors.authorId).toBeDefined();
  });
});
