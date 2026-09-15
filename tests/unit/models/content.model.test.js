const mongoose = require('mongoose');
const Module = require('../../../src/models/module.model');
const Lesson = require('../../../src/models/lesson.model');
const Note = require('../../../src/models/note.model');
const Progress = require('../../../src/models/progress.model');
const Wishlist = require('../../../src/models/wishlist.model');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');

describe('Course Content Models Unit Tests', () => {
  beforeAll(async () => {
    await connectDB();
    await Module.init();
    await Lesson.init();
    await Note.init();
    await Progress.init();
    await Wishlist.init();
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  describe('Module Model', () => {
    test('should save valid module and transform toJSON', async () => {
      const moduleDoc = new Module({
        courseId: new mongoose.Types.ObjectId(),
        title: 'Module 1: Introduction to Express'
      });
      const saved = await moduleDoc.save();

      expect(saved._id).toBeDefined();
      expect(saved.order).toBe(0);
      expect(saved.isPublished).toBe(false);

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });

    test('should fail validation when title is missing', async () => {
      const moduleDoc = new Module({
        courseId: new mongoose.Types.ObjectId()
      });
      let err;
      try {
        await moduleDoc.save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.errors.title).toBeDefined();
    });
  });

  describe('Lesson Model', () => {
    test('should save valid lesson and transform toJSON', async () => {
      const lesson = new Lesson({
        moduleId: new mongoose.Types.ObjectId(),
        courseId: new mongoose.Types.ObjectId(),
        title: 'Lesson 1.1: Middleware Overview',
        type: 'video'
      });
      const saved = await lesson.save();

      expect(saved.order).toBe(0);
      expect(saved.isPreview).toBe(false);

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });

    test('should reject invalid lesson type enum', async () => {
      const lesson = new Lesson({
        moduleId: new mongoose.Types.ObjectId(),
        courseId: new mongoose.Types.ObjectId(),
        title: 'Invalid Lesson',
        type: 'unsupported_type'
      });
      let err;
      try {
        await lesson.save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.errors.type).toBeDefined();
    });
  });

  describe('Note Model', () => {
    test('should save note and transform toJSON', async () => {
      const note = new Note({
        userId: new mongoose.Types.ObjectId(),
        courseId: new mongoose.Types.ObjectId(),
        lessonId: new mongoose.Types.ObjectId(),
        content: 'Important takeaway regarding Express middleware order.'
      });
      const saved = await note.save();

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });
  });

  describe('Progress Model', () => {
    test('should save progress document and transform toJSON', async () => {
      const progress = new Progress({
        userId: new mongoose.Types.ObjectId(),
        courseId: new mongoose.Types.ObjectId(),
        completedLessonCount: 3
      });
      const saved = await progress.save();

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });

    test('should enforce unique active progress per user and course', async () => {
      const userId = new mongoose.Types.ObjectId();
      const courseId = new mongoose.Types.ObjectId();

      await new Progress({ userId, courseId }).save();
      let err;
      try {
        await new Progress({ userId, courseId }).save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.code).toBe(11000);
    });
  });

  describe('Wishlist Model', () => {
    test('should enforce unique wishlist item per user and course', async () => {
      const userId = new mongoose.Types.ObjectId();
      const courseId = new mongoose.Types.ObjectId();

      await new Wishlist({ userId, courseId }).save();
      let err;
      try {
        await new Wishlist({ userId, courseId }).save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.code).toBe(11000);
    });
  });
});
