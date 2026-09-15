const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const axios = require('axios');
const videoService = require('../../../src/services/video.service');
const Lesson = require('../../../src/models/lesson.model');
const Module = require('../../../src/models/module.model');
const Course = require('../../../src/models/course.model');
const Enrollment = require('../../../src/models/enrollment.model');
const Progress = require('../../../src/models/progress.model');
const User = require('../../../src/models/user.model');
const Institution = require('../../../src/models/institution.model');
const env = require('../../../src/config/env');
const { ApiError } = require('../../../src/utils/errors');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');

jest.mock('axios');

jest.mock('../../../src/services/notification.service', () => ({
  createNotification: jest.fn().mockResolvedValue(true),
  sendPushNotification: jest.fn().mockReturnValue(true)
}));

jest.mock('../../../src/services/email.service', () => ({
  sendVideoReadyEmail: jest.fn().mockResolvedValue(true),
  sendVideoUpdatedEmail: jest.fn().mockResolvedValue(true)
}));

const notificationService = require('../../../src/services/notification.service');
const emailService = require('../../../src/services/email.service');

const UPLOADS_DIR = path.join(__dirname, '../../../uploads');
const TEMP_DIR = path.join(UPLOADS_DIR, 'temp');
const VIDEOS_DIR = path.join(UPLOADS_DIR, 'videos');

describe('Video Service Unit Tests', () => {
  let learnerUser, tutorUser, adminUser, sampleInstitution, sampleCourse, sampleModule, sampleLesson;

  beforeAll(async () => {
    await connectDB();
    await Lesson.init();
    await Module.init();
    await Course.init();
    await Enrollment.init();
    await Progress.init();
    await User.init();
    await Institution.init();

    // Ensure upload test folders exist
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    env.mux.tokenId = '';
    env.mux.tokenSecret = '';

    const ownerId = new mongoose.Types.ObjectId();
    sampleInstitution = await Institution.create({
      name: 'Tech University',
      domain: 'techuni.edu',
      code: 'TECHUNI01',
      email: 'contact@techuni.edu',
      owner: ownerId,
      status: 'active'
    });

    learnerUser = await User.create({
      name: 'Learner One',
      email: 'learner@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
      role: 'learner',
      status: 'active',
      institutionId: sampleInstitution._id
    });

    tutorUser = await User.create({
      name: 'Tutor One',
      email: 'tutor@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
      role: 'tutor',
      status: 'active',
      institutionId: sampleInstitution._id
    });

    adminUser = await User.create({
      name: 'Admin User',
      email: 'admin@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
      role: 'super_admin',
      status: 'active'
    });

    sampleCourse = await Course.create({
      title: 'Fullstack Testing Masterclass',
      slug: 'fullstack-testing-masterclass',
      code: 'TEST101',
      description: 'Comprehensive backend testing course',
      category: 'Web Development',
      authorId: tutorUser._id,
      institutionId: sampleInstitution._id,
      status: 'published',
      price: 0
    });

    sampleModule = await Module.create({
      courseId: sampleCourse._id,
      title: 'Module 1: Jest Basics',
      order: 1,
      isPublished: true
    });

    sampleLesson = await Lesson.create({
      courseId: sampleCourse._id,
      moduleId: sampleModule._id,
      title: 'Lesson 1: Introduction to Mocking',
      type: 'video',
      order: 1,
      isPublished: true,
      isPreview: false
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.clearAllTimers();
    await clearDB();
    // Clean up created files in temp or videos folders during tests
    if (fs.existsSync(TEMP_DIR)) {
      try {
        const tempFolders = fs.readdirSync(TEMP_DIR);
        for (const folder of tempFolders) {
          const p = path.join(TEMP_DIR, folder);
          if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
            fs.rmSync(p, { recursive: true, force: true });
          }
        }
      } catch (err) {}
    }
    if (fs.existsSync(VIDEOS_DIR)) {
      try {
        const videoFiles = fs.readdirSync(VIDEOS_DIR);
        for (const file of videoFiles) {
          const p = path.join(VIDEOS_DIR, file);
          if (fs.existsSync(p)) {
            fs.unlinkSync(p);
          }
        }
      } catch (err) {}
    }
  });

  afterAll(async () => {
    await closeDB();
  });

  // ==========================================
  // 1. initializeUpload
  // ==========================================
  describe('initializeUpload', () => {
    test('should throw 404 LESSON_NOT_FOUND if lesson does not exist', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await expect(videoService.initializeUpload({
        lessonId: fakeId,
        fileName: 'lesson1.mp4',
        fileSize: 10 * 1024 * 1024,
        user: tutorUser
      })).rejects.toMatchObject({ statusCode: 404, code: 'LESSON_NOT_FOUND' });
    });

    test('should throw 403 ACCESS_DENIED if user is not author or admin', async () => {
      await expect(videoService.initializeUpload({
        lessonId: sampleLesson._id,
        fileName: 'lesson1.mp4',
        fileSize: 10 * 1024 * 1024,
        user: learnerUser
      })).rejects.toMatchObject({ statusCode: 403, code: 'ACCESS_DENIED' });
    });

    test('should throw 400 FILE_TOO_LARGE if file exceeds 2GB', async () => {
      const hugeSize = 3 * 1024 * 1024 * 1024; // 3GB
      await expect(videoService.initializeUpload({
        lessonId: sampleLesson._id,
        fileName: 'lesson1.mp4',
        fileSize: hugeSize,
        user: tutorUser
      })).rejects.toMatchObject({ statusCode: 400, code: 'FILE_TOO_LARGE' });
    });

    test('should throw 400 INVALID_FILE_TYPE for unsupported video format', async () => {
      await expect(videoService.initializeUpload({
        lessonId: sampleLesson._id,
        fileName: 'lesson1.mkv',
        fileSize: 50 * 1024 * 1024,
        user: tutorUser
      })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_FILE_TYPE' });
    });

    test('should initialize local chunked upload session when Mux is disabled', async () => {
      const result = await videoService.initializeUpload({
        lessonId: sampleLesson._id,
        fileName: 'intro.mp4',
        fileSize: 10 * 1024 * 1024,
        notifyLearners: true,
        user: tutorUser
      });

      expect(result.mode).toBe('local');
      expect(result.uploadId).toBeDefined();
      expect(result.chunkSize).toBe(5 * 1024 * 1024);

      const updatedLesson = await Lesson.findById(sampleLesson._id);
      expect(updatedLesson.videoStatus).toBe('Uploading');
      expect(updatedLesson.videoUploadId).toBe(result.uploadId);
      expect(updatedLesson.notifyEnrolledOnReady).toBe(true);
    });

    test('should initialize Mux direct upload session when Mux is enabled', async () => {
      env.mux.tokenId = 'mock-token-id';
      env.mux.tokenSecret = 'mock-token-secret';

      axios.mockResolvedValueOnce({
        data: {
          data: {
            id: 'mux-upload-123',
            url: 'https://upload.mux.com/mux-upload-123'
          }
        }
      });

      const result = await videoService.initializeUpload({
        lessonId: sampleLesson._id,
        fileName: 'intro.mp4',
        fileSize: 10 * 1024 * 1024,
        user: tutorUser
      });

      expect(result.mode).toBe('mux');
      expect(result.uploadId).toBe('mux-upload-123');
      expect(result.uploadUrl).toBe('https://upload.mux.com/mux-upload-123');

      const updatedLesson = await Lesson.findById(sampleLesson._id);
      expect(updatedLesson.videoUploadId).toBe('mux-upload-123');
    });
  });

  // ==========================================
  // 2. getUploadStatus
  // ==========================================
  describe('getUploadStatus', () => {
    test('should return empty uploadedChunks if videoUploadId is null', async () => {
      const status = await videoService.getUploadStatus({
        lessonId: sampleLesson._id,
        user: tutorUser
      });

      expect(status.videoStatus).toBeNull();
      expect(status.uploadedChunks).toEqual([]);
    });

    test('should query Mux and update lesson to Ready when Mux reports asset_created and asset ready', async () => {
      env.mux.tokenId = 'mock-token-id';
      env.mux.tokenSecret = 'mock-token-secret';

      sampleLesson.videoUploadId = 'mux-upload-999';
      sampleLesson.videoStatus = 'Uploading';
      sampleLesson.notifyEnrolledOnReady = true;
      await sampleLesson.save();

      // Mock Mux Upload GET call
      axios.mockResolvedValueOnce({
        data: {
          data: {
            status: 'asset_created',
            asset_id: 'mux-asset-888'
          }
        }
      });

      // Mock Mux Asset GET call
      axios.mockResolvedValueOnce({
        data: {
          data: {
            status: 'ready',
            playback_ids: [{ id: 'play-id-777' }],
            duration: 125
          }
        }
      });

      const result = await videoService.getUploadStatus({
        lessonId: sampleLesson._id,
        user: tutorUser
      });

      expect(result.mode).toBe('mux');

      const updatedLesson = await Lesson.findById(sampleLesson._id);
      expect(updatedLesson.videoStatus).toBe('Ready');
      expect(updatedLesson.videoUrl).toBe('https://stream.mux.com/play-id-777.m3u8');
      expect(updatedLesson.durationSeconds).toBe(125);

      expect(notificationService.createNotification).toHaveBeenCalled();
    });

    test('should return local chunk list if in local mode', async () => {
      const init = await videoService.initializeUpload({
        lessonId: sampleLesson._id,
        fileName: 'intro.mp4',
        fileSize: 10 * 1024 * 1024,
        user: tutorUser
      });

      // Simulate chunk 0 uploaded
      const sessionTempDir = path.join(TEMP_DIR, init.uploadId);
      fs.writeFileSync(path.join(sessionTempDir, 'chunk_0'), Buffer.from('chunk0'));

      const result = await videoService.getUploadStatus({
        lessonId: sampleLesson._id,
        user: tutorUser
      });

      expect(result.mode).toBe('local');
      expect(result.uploadedChunks).toEqual([0]);
    });
  });

  // ==========================================
  // 3. uploadChunk & completeUpload
  // ==========================================
  describe('uploadChunk & completeUpload', () => {
    let session;

    beforeEach(async () => {
      session = await videoService.initializeUpload({
        lessonId: sampleLesson._id,
        fileName: 'tutorial.mp4',
        fileSize: 10 * 1024 * 1024,
        user: tutorUser
      });
    });

    test('uploadChunk should throw 400 INVALID_SESSION if uploadId does not match lesson', async () => {
      await expect(videoService.uploadChunk({
        lessonId: sampleLesson._id,
        uploadId: 'invalid-session-id',
        chunkIndex: 0,
        fileBuffer: Buffer.from('data'),
        user: tutorUser
      })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SESSION' });
    });

    test('uploadChunk should save chunk buffer to temp folder', async () => {
      const result = await videoService.uploadChunk({
        lessonId: sampleLesson._id,
        uploadId: session.uploadId,
        chunkIndex: 0,
        fileBuffer: Buffer.from('chunk 0 payload'),
        user: tutorUser
      });

      expect(result.success).toBe(true);
      expect(result.chunkIndex).toBe(0);

      const chunkPath = path.join(TEMP_DIR, session.uploadId, 'chunk_0');
      expect(fs.existsSync(chunkPath)).toBe(true);
    });

    test('completeUpload should throw 400 MISSING_CHUNK if a chunk index is missing', async () => {
      // Upload chunk 0 only, but specify totalChunks: 2
      await videoService.uploadChunk({
        lessonId: sampleLesson._id,
        uploadId: session.uploadId,
        chunkIndex: 0,
        fileBuffer: Buffer.from('chunk 0'),
        user: tutorUser
      });

      await expect(videoService.completeUpload({
        lessonId: sampleLesson._id,
        uploadId: session.uploadId,
        totalChunks: 2,
        user: tutorUser
      })).rejects.toMatchObject({ statusCode: 400, code: 'MISSING_CHUNK' });
    });

    test('completeUpload should assemble chunks and set status to Processing', async () => {
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 12345);

      try {
        await videoService.uploadChunk({
          lessonId: sampleLesson._id,
          uploadId: session.uploadId,
          chunkIndex: 0,
          fileBuffer: Buffer.from('chunk 0 '),
          user: tutorUser
        });

        await videoService.uploadChunk({
          lessonId: sampleLesson._id,
          uploadId: session.uploadId,
          chunkIndex: 1,
          fileBuffer: Buffer.from('chunk 1'),
          user: tutorUser
        });

        const res = await videoService.completeUpload({
          lessonId: sampleLesson._id,
          uploadId: session.uploadId,
          totalChunks: 2,
          user: tutorUser
        });

        expect(res.success).toBe(true);
        expect(res.videoStatus).toBe('Processing');

        const updatedLesson = await Lesson.findById(sampleLesson._id);
        expect(updatedLesson.videoStatus).toBe('Processing');
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });
  });

  // ==========================================
  // 4. handleMuxWebhook
  // ==========================================
  describe('handleMuxWebhook', () => {
    test('should ignore webhook if passthrough / lessonId is missing', async () => {
      await videoService.handleMuxWebhook({
        type: 'video.asset.ready',
        data: {}
      });
      // Does not throw
    });

    test('should update lesson to Processing on video.upload.asset_created', async () => {
      await videoService.handleMuxWebhook({
        type: 'video.upload.asset_created',
        data: { passthrough: sampleLesson._id.toString() }
      });

      const updated = await Lesson.findById(sampleLesson._id);
      expect(updated.videoStatus).toBe('Processing');
    });

    test('should update lesson to Ready on video.asset.ready and notify tutor & enrolled students', async () => {
      // Create active enrollment for learner
      await Enrollment.create({
        userId: learnerUser._id,
        courseId: sampleCourse._id,
        enrollmentType: 'free',
        status: 'active'
      });

      sampleLesson.notifyEnrolledOnReady = true;
      await sampleLesson.save();

      await videoService.handleMuxWebhook({
        type: 'video.asset.ready',
        data: {
          passthrough: sampleLesson._id.toString(),
          playback_ids: [{ id: 'mux-playback-abc' }],
          duration: 300
        }
      });

      const updated = await Lesson.findById(sampleLesson._id);
      expect(updated.videoStatus).toBe('Ready');
      expect(updated.videoUrl).toBe('https://stream.mux.com/mux-playback-abc.m3u8');
      expect(updated.durationSeconds).toBe(300);

      expect(notificationService.createNotification).toHaveBeenCalled();
      expect(emailService.sendVideoReadyEmail).toHaveBeenCalled();
      expect(emailService.sendVideoUpdatedEmail).toHaveBeenCalled();
    });

    test('should update lesson to Failed on video.asset.errored', async () => {
      await videoService.handleMuxWebhook({
        type: 'video.asset.errored',
        data: {
          passthrough: sampleLesson._id.toString(),
          errors: { message: 'Corrupted video codec' }
        }
      });

      const updated = await Lesson.findById(sampleLesson._id);
      expect(updated.videoStatus).toBe('Failed');
      expect(updated.videoProcessingError).toBe('Corrupted video codec');
    });
  });

  // ==========================================
  // 5. signVideoUrl
  // ==========================================
  describe('signVideoUrl', () => {
    test('should return null for empty or malformed videoUrl', () => {
      expect(videoService.signVideoUrl(null, sampleLesson._id, learnerUser._id)).toBeNull();
      expect(videoService.signVideoUrl('invalid-path', sampleLesson._id, learnerUser._id)).toBeNull();
    });

    test('should pass Mux stream URLs through without modification', () => {
      const muxUrl = 'https://stream.mux.com/play-123.m3u8';
      expect(videoService.signVideoUrl(muxUrl, sampleLesson._id, learnerUser._id)).toBe(muxUrl);
    });

    test('should generate secure signed URL for local video paths', () => {
      const localUrl = '/uploads/videos/sample.mp4';
      const signed = videoService.signVideoUrl(localUrl, sampleLesson._id, learnerUser._id);
      expect(signed).toContain(`/api/v1/lessons/${sampleLesson._id}/video/stream?token=`);
    });
  });

  // ==========================================
  // 6. streamLocalVideo
  // ==========================================
  describe('streamLocalVideo', () => {
    test('should throw 401 ACCESS_TOKEN_REQUIRED if token is missing', async () => {
      const req = { params: { id: sampleLesson._id }, query: {} };
      await expect(videoService.streamLocalVideo(req, {})).rejects.toMatchObject({
        statusCode: 401,
        code: 'ACCESS_TOKEN_REQUIRED'
      });
    });

    test('should throw 401 INVALID_STREAM_TOKEN if token signature is invalid', async () => {
      const req = { params: { id: sampleLesson._id }, query: { token: 'invalid-jwt-token' } };
      await expect(videoService.streamLocalVideo(req, {})).rejects.toMatchObject({
        statusCode: 401,
        code: 'INVALID_STREAM_TOKEN'
      });
    });

    test('should throw 403 ENROLLMENT_REQUIRED for non-preview lesson when user has no active enrollment', async () => {
      const token = jwt.sign(
        { userId: String(learnerUser._id), lessonId: String(sampleLesson._id) },
        env.jwt.accessSecret
      );
      const req = { params: { id: sampleLesson._id }, query: { token } };

      await expect(videoService.streamLocalVideo(req, {})).rejects.toMatchObject({
        statusCode: 403,
        code: 'ENROLLMENT_REQUIRED'
      });
    });

    test('should allow course author to stream non-preview lesson even without student enrollment', async () => {
      // Create a dummy video file in VIDEOS_DIR for streaming test
      const videoFileName = `${sampleLesson._id}.mp4`;
      const videoFilePath = path.join(VIDEOS_DIR, videoFileName);
      fs.writeFileSync(videoFilePath, Buffer.from('dummy video data'));

      const token = jwt.sign(
        { userId: String(tutorUser._id), lessonId: String(sampleLesson._id) },
        env.jwt.accessSecret
      );

      const req = {
        params: { id: sampleLesson._id },
        query: { token },
        headers: {}
      };

      const { Writable } = require('stream');
      const res = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        }
      });
      res.setHeader = jest.fn();
      res.writeHead = jest.fn();

      await videoService.streamLocalVideo(req, res);
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });

    test('should throw 403 LESSON_LOCKED for sequential course if previous lesson is not completed', async () => {
      sampleCourse.isSequential = true;
      await sampleCourse.save();

      const lesson2 = await Lesson.create({
        courseId: sampleCourse._id,
        moduleId: sampleModule._id,
        title: 'Lesson 2: Advanced Mocking',
        type: 'video',
        order: 2,
        isPublished: true,
        isPreview: false
      });

      await Enrollment.create({
        userId: learnerUser._id,
        courseId: sampleCourse._id,
        enrollmentType: 'free',
        status: 'active'
      });

      const token = jwt.sign(
        { userId: String(learnerUser._id), lessonId: String(lesson2._id) },
        env.jwt.accessSecret
      );
      const req = { params: { id: lesson2._id }, query: { token } };

      await expect(videoService.streamLocalVideo(req, {})).rejects.toMatchObject({
        statusCode: 403,
        code: 'LESSON_LOCKED'
      });
    });
  });

  // ==========================================
  // 7. recoverStrandedProcessingVideos
  // ==========================================
  describe('recoverStrandedProcessingVideos', () => {
    test('should run recovery cleanly when no stranded lessons exist', async () => {
      await videoService.recoverStrandedProcessingVideos();
      // Completes with no errors
    });

    test('should recover stranded local lesson to Failed when local video file does not exist on disk', async () => {
      sampleLesson.videoStatus = 'Processing';
      await sampleLesson.save();

      await videoService.recoverStrandedProcessingVideos();

      const updated = await Lesson.findById(sampleLesson._id);
      expect(updated.videoStatus).toBe('Failed');
      expect(updated.videoProcessingError).toBe('Video processing interrupted by server shutdown.');
    });

    test('should recover stranded Mux upload session', async () => {
      env.mux.tokenId = 'mock-token-id';
      env.mux.tokenSecret = 'mock-token-secret';

      sampleLesson.videoStatus = 'Processing';
      sampleLesson.videoUploadId = 'stranded-mux-upload';
      await sampleLesson.save();

      axios.mockResolvedValueOnce({
        data: {
          data: {
            status: 'asset_created',
            asset_id: 'stranded-asset-id'
          }
        }
      });

      axios.mockResolvedValueOnce({
        data: {
          data: {
            status: 'ready',
            playback_ids: [{ id: 'stranded-play-id' }],
            duration: 180
          }
        }
      });

      await videoService.recoverStrandedProcessingVideos();

      const updated = await Lesson.findById(sampleLesson._id);
      expect(updated.videoStatus).toBe('Ready');
      expect(updated.videoUrl).toBe('https://stream.mux.com/stranded-play-id.m3u8');
    });
  });
});
