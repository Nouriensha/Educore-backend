const mongoose = require('mongoose');
const TutorAssignment = require('../../../src/models/tutorAssignment.model');
const AttendanceRecord = require('../../../src/models/attendanceRecord.model');
const AttendanceSession = require('../../../src/models/attendanceSession.model');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');

describe('Tutor Assignment & Detailed Attendance Models Unit Tests', () => {
  beforeAll(async () => {
    await connectDB();
    await TutorAssignment.init();
    await AttendanceRecord.init();
    await AttendanceSession.init();
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  describe('TutorAssignment Model', () => {
    test('should save valid tutor assignment and format toJSON', async () => {
      const assignment = new TutorAssignment({
        institutionId: new mongoose.Types.ObjectId(),
        tutorId: new mongoose.Types.ObjectId(),
        courseId: new mongoose.Types.ObjectId(),
        assignmentType: 'course',
        assignedBy: new mongoose.Types.ObjectId()
      });
      const saved = await assignment.save();

      expect(saved.status).toBe('active');

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });

    test('should enforce unique active tutor assignment per course in an institution', async () => {
      const institutionId = new mongoose.Types.ObjectId();
      const courseId = new mongoose.Types.ObjectId();
      const assignedBy = new mongoose.Types.ObjectId();

      await new TutorAssignment({
        institutionId,
        tutorId: new mongoose.Types.ObjectId(),
        courseId,
        assignmentType: 'course',
        assignedBy
      }).save();

      let err;
      try {
        await new TutorAssignment({
          institutionId,
          tutorId: new mongoose.Types.ObjectId(),
          courseId,
          assignmentType: 'course',
          assignedBy
        }).save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.code).toBe(11000);
    });
  });

  describe('AttendanceRecord Model', () => {
    test('should save attendance record and enforce unique student per session', async () => {
      const attendanceSessionId = new mongoose.Types.ObjectId();
      const institutionId = new mongoose.Types.ObjectId();
      const batchId = new mongoose.Types.ObjectId();
      const studentId = new mongoose.Types.ObjectId();
      const markedBy = new mongoose.Types.ObjectId();

      const rec = new AttendanceRecord({
        attendanceSessionId,
        institutionId,
        batchId,
        studentId,
        status: 'present',
        markedBy
      });
      await rec.save();

      let err;
      try {
        await new AttendanceRecord({
          attendanceSessionId,
          institutionId,
          batchId,
          studentId,
          status: 'absent',
          markedBy
        }).save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.code).toBe(11000);
    });
  });

  describe('AttendanceSession Model', () => {
    test('should save attendance session and enforce unique date per batch', async () => {
      const institutionId = new mongoose.Types.ObjectId();
      const batchId = new mongoose.Types.ObjectId();
      const tutorId = new mongoose.Types.ObjectId();
      const createdBy = tutorId;
      const attendanceDate = new Date('2026-10-15');

      const session = new AttendanceSession({
        institutionId,
        batchId,
        tutorId,
        attendanceDate,
        createdBy
      });
      await session.save();

      let err;
      try {
        await new AttendanceSession({
          institutionId,
          batchId,
          tutorId,
          attendanceDate,
          createdBy
        }).save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.code).toBe(11000);
    });
  });
});
