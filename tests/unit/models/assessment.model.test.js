const mongoose = require('mongoose');
const QuizAttempt = require('../../../src/models/quizAttempt.model');
const Submission = require('../../../src/models/submission.model');
const Review = require('../../../src/models/review.model');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');

describe('Assessment & Review Models Unit Tests', () => {
  beforeAll(async () => {
    await connectDB();
    await QuizAttempt.init();
    await Submission.init();
    await Review.init();
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  describe('QuizAttempt Model', () => {
    test('should save quiz attempt and transform toJSON', async () => {
      const attempt = new QuizAttempt({
        userId: new mongoose.Types.ObjectId(),
        lessonId: new mongoose.Types.ObjectId(),
        courseId: new mongoose.Types.ObjectId(),
        score: 85,
        maxScore: 100,
        percentage: 85,
        passed: true
      });
      const saved = await attempt.save();

      expect(saved.attemptNumber).toBe(1);
      expect(saved.status).toBe('submitted');

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });

    test('should enforce unique index per attemptNumber per user and lesson', async () => {
      const userId = new mongoose.Types.ObjectId();
      const lessonId = new mongoose.Types.ObjectId();
      const courseId = new mongoose.Types.ObjectId();

      await new QuizAttempt({ userId, lessonId, courseId, attemptNumber: 1 }).save();
      let err;
      try {
        await new QuizAttempt({ userId, lessonId, courseId, attemptNumber: 1 }).save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.code).toBe(11000);
    });
  });

  describe('Submission Model', () => {
    test('should save submission and transform toJSON', async () => {
      const sub = new Submission({
        userId: new mongoose.Types.ObjectId(),
        lessonId: new mongoose.Types.ObjectId(),
        courseId: new mongoose.Types.ObjectId(),
        submissionType: 'text',
        content: 'Written essay submission response.'
      });
      const saved = await sub.save();

      expect(saved.status).toBe('submitted');

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });

    test('should reject invalid submissionType enum', async () => {
      const sub = new Submission({
        userId: new mongoose.Types.ObjectId(),
        lessonId: new mongoose.Types.ObjectId(),
        courseId: new mongoose.Types.ObjectId(),
        submissionType: 'audio' // Invalid
      });
      let err;
      try {
        await sub.save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.errors.submissionType).toBeDefined();
    });
  });

  describe('Review Model', () => {
    test('should save valid review and transform toJSON', async () => {
      const review = new Review({
        userId: new mongoose.Types.ObjectId(),
        courseId: new mongoose.Types.ObjectId(),
        rating: 5,
        comment: 'Outstanding course material!'
      });
      const saved = await review.save();

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });

    test('should fail validation when rating is outside 1-5 range', async () => {
      const review = new Review({
        userId: new mongoose.Types.ObjectId(),
        courseId: new mongoose.Types.ObjectId(),
        rating: 6
      });
      let err;
      try {
        await review.save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.errors.rating).toBeDefined();
    });

    test('should enforce unique active review per user and course', async () => {
      const userId = new mongoose.Types.ObjectId();
      const courseId = new mongoose.Types.ObjectId();

      await new Review({ userId, courseId, rating: 4 }).save();
      let err;
      try {
        await new Review({ userId, courseId, rating: 5 }).save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.code).toBe(11000);
    });
  });
});
