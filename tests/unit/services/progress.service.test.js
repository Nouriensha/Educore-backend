const mongoose = require('mongoose');
const progressService = require('../../../src/services/progress.service');
const User = require('../../../src/models/user.model');
const Course = require('../../../src/models/course.model');
const Lesson = require('../../../src/models/lesson.model');
const Module = require('../../../src/models/module.model');
const Enrollment = require('../../../src/models/enrollment.model');
const Progress = require('../../../src/models/progress.model');
const LiveRecording = require('../../../src/models/liveRecording.model');
const QuizAttempt = require('../../../src/models/quizAttempt.model');
const Submission = require('../../../src/models/submission.model');
const { ApiError } = require('../../../src/utils/errors');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { buildUser } = require('../../fixtures/user.fixture');
const { buildEnrollment } = require('../../fixtures/enrollment.fixture');

jest.mock('../../../src/queues/certificate.queue', () => ({
  triggerCertificateGeneration: jest.fn().mockResolvedValue(true)
}));

const certificateQueue = require('../../../src/queues/certificate.queue');

describe('Progress Service Unit Tests', () => {
  let user;
  let author;

  beforeAll(async () => {
    await connectDB();
  });

  beforeEach(async () => {
    user = await new User(buildUser({ email: 'student@example.com' })).save();
    author = await new User(buildUser({ email: 'tutor@example.com', role: 'tutor' })).save();
  });

  afterEach(async () => {
    await clearDB();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await closeDB();
  });

  // ======================================================
  // 1. GET PROGRESS
  // ======================================================
  describe('getProgress', () => {
    test('should throw 403 ENROLLMENT_REQUIRED if user has no active enrollment', async () => {
      const courseId = new mongoose.Types.ObjectId();

      let err;
      try {
        await progressService.getProgress({ userId: user._id, courseId });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe('ENROLLMENT_REQUIRED');
    });

    test('should return default progress data if user is enrolled but no progress record exists', async () => {
      const courseId = new mongoose.Types.ObjectId();
      await new Enrollment(buildEnrollment(user._id, courseId, { status: 'active' })).save();

      const result = await progressService.getProgress({ userId: user._id, courseId });

      expect(result.message).toBe('Progress retrieved successfully');
      expect(result.data).toEqual({
        courseId,
        completedLessons: [],
        completedLessonCount: 0,
        lastAccessedLesson: null,
        progressPercentage: 0
      });
    });

    test('should return stored progress document if progress record exists', async () => {
      const courseId = new mongoose.Types.ObjectId();
      const lessonId = new mongoose.Types.ObjectId();
      await new Enrollment(buildEnrollment(user._id, courseId, { status: 'active' })).save();
      await new Progress({
        userId: user._id,
        courseId,
        completedLessons: [lessonId],
        completedLessonCount: 1,
        lastAccessedLesson: lessonId
      }).save();

      const result = await progressService.getProgress({ userId: user._id, courseId });

      expect(result.message).toBe('Progress retrieved successfully');
      expect(result.data.completedLessonCount).toBe(1);
      expect(String(result.data.completedLessons[0])).toBe(lessonId.toString());
    });
  });

  // ======================================================
  // 2. MARK LESSON COMPLETE
  // ======================================================
  describe('markLessonComplete', () => {
    test('should throw 403 ENROLLMENT_REQUIRED if user is not actively enrolled', async () => {
      const courseId = new mongoose.Types.ObjectId();
      const lessonId = new mongoose.Types.ObjectId();

      let err;
      try {
        await progressService.markLessonComplete({ userId: user._id, courseId, lessonId });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe('ENROLLMENT_REQUIRED');
    });

    test('should throw 404 LESSON_NOT_FOUND if lesson does not exist', async () => {
      const courseId = new mongoose.Types.ObjectId();
      const lessonId = new mongoose.Types.ObjectId();
      await new Enrollment(buildEnrollment(user._id, courseId, { status: 'active' })).save();

      let err;
      try {
        await progressService.markLessonComplete({ userId: user._id, courseId, lessonId });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe('LESSON_NOT_FOUND');
    });

    test('should throw 404 COURSE_NOT_FOUND if course does not exist', async () => {
      const courseId = new mongoose.Types.ObjectId();
      const moduleId = new mongoose.Types.ObjectId();
      const lesson = await new Lesson({
        title: 'Lesson 1',
        courseId,
        moduleId,
        contentType: 'video',
        videoUrl: 'https://example.com/video.mp4',
        durationSeconds: 120
      }).save();

      await new Enrollment(buildEnrollment(user._id, courseId, { status: 'active' })).save();

      let err;
      try {
        await progressService.markLessonComplete({ userId: user._id, courseId, lessonId: lesson._id });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe('COURSE_NOT_FOUND');
    });

    test('should create progress and mark lesson complete for non-sequential course', async () => {
      const course = await new Course({
        title: 'React Basics',
        description: 'Learn React fundamentals',
        category: 'Development',
        level: 'Beginner',
        authorId: author._id,
        totalLessons: 2,
        isSequential: false
      }).save();

      const moduleId = new mongoose.Types.ObjectId();
      const lesson = await new Lesson({
        title: 'JSX Introduction',
        courseId: course._id,
        moduleId,
        contentType: 'text'
      }).save();

      await new Enrollment(buildEnrollment(user._id, course._id, { status: 'active' })).save();

      const result = await progressService.markLessonComplete({
        userId: user._id,
        courseId: course._id,
        lessonId: lesson._id
      });

      expect(result.message).toBe('Lesson marked as complete');
      expect(result.data.completedLessonCount).toBe(1);
      expect(result.data.progressPercentage).toBe(50); // 1 of 2 lessons = 50%

      const updatedEnrollment = await Enrollment.findOne({ userId: user._id, courseId: course._id });
      expect(updatedEnrollment.progressPercentage).toBe(50);
    });

    test('should return early message if lesson is already marked as complete (idempotency)', async () => {
      const course = await new Course({
        title: 'Node.js Essentials',
        description: 'Node.js backend guide',
        category: 'Development',
        level: 'Intermediate',
        authorId: author._id,
        totalLessons: 1
      }).save();

      const moduleId = new mongoose.Types.ObjectId();
      const lesson = await new Lesson({
        title: 'Event Loop',
        courseId: course._id,
        moduleId,
        contentType: 'text'
      }).save();

      await new Enrollment(buildEnrollment(user._id, course._id, { status: 'active' })).save();
      await new Progress({
        userId: user._id,
        courseId: course._id,
        completedLessons: [lesson._id],
        completedLessonCount: 1,
        lastAccessedLesson: lesson._id
      }).save();

      const result = await progressService.markLessonComplete({
        userId: user._id,
        courseId: course._id,
        lessonId: lesson._id
      });

      expect(result.message).toBe('Lesson already marked as complete');
      expect(result.data.progressPercentage).toBe(100);
    });

    test('should throw 403 LESSON_LOCKED if sequential course has uncompleted previous lesson', async () => {
      const course = await new Course({
        title: 'Sequential Python',
        description: 'Step by step Python',
        category: 'Development',
        level: 'Beginner',
        authorId: author._id,
        totalLessons: 2,
        isSequential: true
      }).save();

      const moduleObj = await new Module({
        title: 'Module 1',
        courseId: course._id,
        order: 1,
        isPublished: true
      }).save();

      const lesson1 = await new Lesson({
        title: 'Variables',
        courseId: course._id,
        moduleId: moduleObj._id,
        order: 1,
        isPublished: true,
        contentType: 'text'
      }).save();

      const lesson2 = await new Lesson({
        title: 'Functions',
        courseId: course._id,
        moduleId: moduleObj._id,
        order: 2,
        isPublished: true,
        contentType: 'text'
      }).save();

      await new Enrollment(buildEnrollment(user._id, course._id, { status: 'active' })).save();

      let err;
      try {
        await progressService.markLessonComplete({
          userId: user._id,
          courseId: course._id,
          lessonId: lesson2._id
        });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe('LESSON_LOCKED');
    });

    test('should throw 403 LESSON_LOCKED if sequential course has locked previous module', async () => {
      const course = await new Course({
        title: 'Advanced Sequential Course',
        description: 'Multi module sequential course',
        category: 'Development',
        level: 'Advanced',
        authorId: author._id,
        totalLessons: 2,
        isSequential: true
      }).save();

      const module1 = await new Module({
        title: 'Module 1',
        courseId: course._id,
        order: 1,
        isPublished: true
      }).save();

      const module2 = await new Module({
        title: 'Module 2',
        courseId: course._id,
        order: 2,
        isPublished: true
      }).save();

      await new Lesson({
        title: 'Lesson 1',
        courseId: course._id,
        moduleId: module1._id,
        order: 1,
        isPublished: true,
        contentType: 'text'
      }).save();

      const lesson2 = await new Lesson({
        title: 'Lesson 2',
        courseId: course._id,
        moduleId: module2._id,
        order: 1,
        isPublished: true,
        contentType: 'text'
      }).save();

      await new Enrollment(buildEnrollment(user._id, course._id, { status: 'active' })).save();

      let err;
      try {
        await progressService.markLessonComplete({
          userId: user._id,
          courseId: course._id,
          lessonId: lesson2._id
        });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe('LESSON_LOCKED');
    });

    test('should trigger certificate generation when progress reaches >= 90% and certificate is enabled', async () => {
      const course = await new Course({
        title: 'Certificate Masterclass',
        description: 'Earn a certificate',
        category: 'Development',
        level: 'Beginner',
        authorId: author._id,
        totalLessons: 1,
        certificateEnabled: true
      }).save();

      const moduleId = new mongoose.Types.ObjectId();
      const lesson = await new Lesson({
        title: 'Final Lesson',
        courseId: course._id,
        moduleId,
        contentType: 'text'
      }).save();

      await new Enrollment(buildEnrollment(user._id, course._id, { status: 'active' })).save();

      const result = await progressService.markLessonComplete({
        userId: user._id,
        courseId: course._id,
        lessonId: lesson._id
      });

      expect(result.data.progressPercentage).toBe(100);
      expect(certificateQueue.triggerCertificateGeneration).toHaveBeenCalledWith({
        userId: user._id,
        courseId: course._id
      });
    });
  });

  // ======================================================
  // 3. UPDATE VIDEO PLAYBACK PROGRESS
  // ======================================================
  describe('updateVideoProgress', () => {
    test('should throw 403 ENROLLMENT_REQUIRED if user is not actively enrolled', async () => {
      const courseId = new mongoose.Types.ObjectId();
      const lessonId = new mongoose.Types.ObjectId();

      let err;
      try {
        await progressService.updateVideoProgress({
          userId: user._id,
          courseId,
          lessonId,
          watchTime: 120,
          percentage: 50
        });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe('ENROLLMENT_REQUIRED');
    });

    test('should throw 404 COURSE_NOT_FOUND if course is missing', async () => {
      const courseId = new mongoose.Types.ObjectId();
      const lessonId = new mongoose.Types.ObjectId();
      await new Enrollment(buildEnrollment(user._id, courseId, { status: 'active' })).save();

      let err;
      try {
        await progressService.updateVideoProgress({
          userId: user._id,
          courseId,
          lessonId,
          watchTime: 120,
          percentage: 50
        });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe('COURSE_NOT_FOUND');
    });

    test('should throw 404 LESSON_NOT_FOUND if lesson is missing', async () => {
      const course = await new Course({
        title: 'Video Course',
        description: 'Learn Video',
        category: 'Media',
        level: 'Beginner',
        authorId: author._id
      }).save();

      const lessonId = new mongoose.Types.ObjectId();
      await new Enrollment(buildEnrollment(user._id, course._id, { status: 'active' })).save();

      let err;
      try {
        await progressService.updateVideoProgress({
          userId: user._id,
          courseId: course._id,
          lessonId,
          secondsWatched: 60,
          progressPercentage: 40
        });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe('LESSON_NOT_FOUND');
    });

    test('should create progress and update video playback stats', async () => {
      const course = await new Course({
        title: 'Video Streaming Course',
        description: 'Watch video lessons',
        category: 'Media',
        level: 'Beginner',
        authorId: author._id,
        totalLessons: 2
      }).save();

      const moduleId = new mongoose.Types.ObjectId();
      const lesson = await new Lesson({
        title: 'Stream 1',
        courseId: course._id,
        moduleId,
        contentType: 'video'
      }).save();

      await new Enrollment(buildEnrollment(user._id, course._id, { status: 'active' })).save();

      const result = await progressService.updateVideoProgress({
        userId: user._id,
        courseId: course._id,
        lessonId: lesson._id,
        watchTime: 300,
        percentage: 50
      });

      expect(result.message).toBe('Playback progress updated successfully');
      expect(result.data.lessonProgress.length).toBe(1);
      expect(result.data.lessonProgress[0].watchTime).toBe(300);
      expect(result.data.lessonProgress[0].percentage).toBe(50);
      expect(result.data.videoProgress[0].secondsWatched).toBe(300);
    });

    test('should auto-complete lesson when percentage reaches >= 90% and trigger certificate', async () => {
      const course = await new Course({
        title: 'High Percentage Video Course',
        description: 'Auto completion test',
        category: 'Media',
        level: 'Beginner',
        authorId: author._id,
        totalLessons: 1,
        certificateEnabled: true
      }).save();

      const moduleId = new mongoose.Types.ObjectId();
      const lesson = await new Lesson({
        title: 'Full Video',
        courseId: course._id,
        moduleId,
        contentType: 'video'
      }).save();

      await new Enrollment(buildEnrollment(user._id, course._id, { status: 'active' })).save();

      const result = await progressService.updateVideoProgress({
        userId: user._id,
        courseId: course._id,
        lessonId: lesson._id,
        secondsWatched: 540,
        progressPercentage: 95
      });

      expect(result.data.completedLessonCount).toBe(1);
      expect(result.data.progressPercentage).toBe(100);
      expect(certificateQueue.triggerCertificateGeneration).toHaveBeenCalledWith({
        userId: user._id,
        courseId: course._id
      });
    });
  });

  // ======================================================
  // 4. UPDATE RECORDING PLAYBACK PROGRESS
  // ======================================================
  describe('updateRecordingProgress', () => {
    test('should throw 404 RECORDING_NOT_FOUND if recording does not exist', async () => {
      const recordingId = new mongoose.Types.ObjectId();

      let err;
      try {
        await progressService.updateRecordingProgress({
          userId: user._id,
          recordingId,
          watchTime: 120
        });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe('RECORDING_NOT_FOUND');
    });

    test('should throw 403 ENROLLMENT_REQUIRED if user is not enrolled in recording course', async () => {
      const courseId = new mongoose.Types.ObjectId();
      const sessionId = new mongoose.Types.ObjectId();
      const recording = await new LiveRecording({
        title: 'Live Recording Session 1',
        tutorId: author._id,
        sessionId,
        courseId,
        recordingUrl: 'https://example.com/recording.mp4',
        durationSeconds: 1800
      }).save();

      let err;
      try {
        await progressService.updateRecordingProgress({
          userId: user._id,
          recordingId: recording._id,
          watchTime: 300
        });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe('ENROLLMENT_REQUIRED');
    });

    test('should successfully update recording progress entry', async () => {
      const courseId = new mongoose.Types.ObjectId();
      const sessionId = new mongoose.Types.ObjectId();
      const recording = await new LiveRecording({
        title: 'Live Recording Session 1',
        tutorId: author._id,
        sessionId,
        courseId,
        recordingUrl: 'https://example.com/recording.mp4',
        durationSeconds: 1800
      }).save();

      await new Enrollment(buildEnrollment(user._id, courseId, { status: 'active' })).save();

      const result = await progressService.updateRecordingProgress({
        userId: user._id,
        recordingId: recording._id,
        watchTime: 600
      });

      expect(result.message).toBe('Recording progress updated successfully');
      expect(result.data.recordingProgress.length).toBe(1);
      expect(result.data.recordingProgress[0].secondsWatched).toBe(600);

      // Repeat update for existing recording entry
      const repeatResult = await progressService.updateRecordingProgress({
        userId: user._id,
        recordingId: recording._id,
        watchTime: 1200
      });

      expect(repeatResult.data.recordingProgress.length).toBe(1);
      expect(repeatResult.data.recordingProgress[0].secondsWatched).toBe(1200);
    });
  });

  // ======================================================
  // 5. GET LEARNER ANALYTICS
  // ======================================================
  describe('getLearnerAnalytics', () => {
    test('should return default analytics for user with no progress or activity', async () => {
      const result = await progressService.getLearnerAnalytics({ userId: user._id });

      expect(result.message).toBe('Learner analytics fetched successfully');
      expect(result.data).toEqual({
        totalHoursWatched: 0,
        coursesCount: {
          inProgress: 0,
          completed: 0
        },
        quizAverage: 0,
        streak: {
          currentStreak: 0,
          maxStreak: 0,
          activeDaysCount: 0
        },
        activityHeatmap: []
      });
    });

    test('should compute watched hours, quiz averages, streaks, and heatmap from user activity', async () => {
      const courseId = new mongoose.Types.ObjectId();
      const lessonId = new mongoose.Types.ObjectId();

      await new Enrollment(buildEnrollment(user._id, courseId, { status: 'active' })).save();

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      await new Progress({
        userId: user._id,
        courseId,
        completedLessons: [lessonId],
        completedLessonCount: 1,
        videoProgress: [{ lessonId, secondsWatched: 3600, lastWatchedAt: yesterday }],
        recordingProgress: [{ recordingId: new mongoose.Types.ObjectId(), secondsWatched: 1800, lastWatchedAt: new Date() }]
      }).save();

      await new QuizAttempt({
        userId: user._id,
        lessonId,
        courseId,
        attemptNumber: 1,
        score: 80,
        totalQuestions: 100,
        percentage: 80,
        passed: true
      }).save();

      await new Submission({
        userId: user._id,
        lessonId,
        courseId,
        submissionType: 'file',
        fileUrl: 'https://example.com/file.pdf'
      }).save();

      const result = await progressService.getLearnerAnalytics({ userId: user._id });

      expect(result.data.totalHoursWatched).toBe(1.5); // (3600 + 1800) / 3600 = 1.5 hours
      expect(result.data.coursesCount.inProgress).toBe(1);
      expect(result.data.quizAverage).toBe(80);
      expect(result.data.streak.activeDaysCount).toBeGreaterThanOrEqual(1);
      expect(result.data.activityHeatmap.length).toBeGreaterThan(0);
    });
  });
});
