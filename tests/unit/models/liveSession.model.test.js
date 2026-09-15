const mongoose = require('mongoose');
const LiveSession = require('../../../src/models/liveSession.model');
const LiveRecording = require('../../../src/models/liveRecording.model');
const CourseAudit = require('../../../src/models/courseAudit.model');
const RefreshToken = require('../../../src/models/refreshToken.model');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');

describe('Live Session, Recording, Audit & RefreshToken Models Unit Tests', () => {
  beforeAll(async () => {
    await connectDB();
    await LiveSession.init();
    await LiveRecording.init();
    await CourseAudit.init();
    await RefreshToken.init();
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  describe('LiveSession Model', () => {
    test('should save valid live session', async () => {
      const session = new LiveSession({
        courseId: new mongoose.Types.ObjectId(),
        tutorId: new mongoose.Types.ObjectId(),
        title: 'Weekly Q&A Live Session',
        startTime: new Date('2026-10-01T10:00:00Z'),
        endTime: new Date('2026-10-01T11:00:00Z'),
        timezone: 'Asia/Kolkata',
        durationMinutes: 60
      });
      const saved = await session.save();

      expect(saved.provider).toBe('google_meet');
      expect(saved.status).toBe('scheduled');
    });

    test('should reject invalid live session status enum', async () => {
      const session = new LiveSession({
        courseId: new mongoose.Types.ObjectId(),
        tutorId: new mongoose.Types.ObjectId(),
        title: 'Invalid status session',
        startTime: new Date(),
        endTime: new Date(),
        timezone: 'UTC',
        durationMinutes: 30,
        status: 'invalid_status'
      });
      let err;
      try {
        await session.save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.errors.status).toBeDefined();
    });
  });

  describe('LiveRecording Model', () => {
    test('should save valid live recording', async () => {
      const rec = new LiveRecording({
        sessionId: new mongoose.Types.ObjectId(),
        courseId: new mongoose.Types.ObjectId(),
        tutorId: new mongoose.Types.ObjectId(),
        title: 'Recording 1'
      });
      const saved = await rec.save();

      expect(saved.provider).toBe('mux');
      expect(saved.processingStatus).toBe('uploading');
      expect(saved.status).toBe('draft');
    });
  });

  describe('CourseAudit Model', () => {
    test('should save course audit record with valid action enum', async () => {
      const audit = new CourseAudit({
        courseId: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
        action: 'status_change',
        changes: { from: 'draft', to: 'published' }
      });
      const saved = await audit.save();

      expect(saved.action).toBe('status_change');
    });
  });

  describe('RefreshToken Model', () => {
    test('should save refresh token and hide select:false tokenHash on default find', async () => {
      const token = new RefreshToken({
        userId: new mongoose.Types.ObjectId(),
        tokenHash: 'hashed_token_value_abc',
        expiresAt: new Date(Date.now() + 604800000)
      });
      await token.save();

      const found = await RefreshToken.findById(token._id);
      expect(found.tokenHash).toBeUndefined();

      const foundWithSecret = await RefreshToken.findById(token._id).select('+tokenHash');
      expect(foundWithSecret.tokenHash).toBe('hashed_token_value_abc');
    });
  });
});
