const mongoose = require('mongoose');
const Attendance = require('../../../src/models/attendance.model');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');

describe('Attendance Model Unit Tests', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  test('should successfully create & save valid attendance record', async () => {
    const validData = {
      sessionId: new mongoose.Types.ObjectId(),
      learnerId: new mongoose.Types.ObjectId(),
      attendanceStatus: 'present',
      totalMinutes: 45
    };

    const attendance = new Attendance(validData);
    const saved = await attendance.save();

    expect(saved._id).toBeDefined();
    expect(saved.attendanceStatus).toBe('present');
    expect(saved.totalMinutes).toBe(45);
  });

  test('should fail validation when required fields (sessionId, learnerId) are missing', async () => {
    const attendance = new Attendance({});

    let err;
    try {
      await attendance.save();
    } catch (error) {
      err = error;
    }

    expect(err).toBeDefined();
    expect(err.errors.sessionId).toBeDefined();
    expect(err.errors.learnerId).toBeDefined();
  });

  test('should fail validation for invalid attendanceStatus enum value', async () => {
    const invalidData = {
      sessionId: new mongoose.Types.ObjectId(),
      learnerId: new mongoose.Types.ObjectId(),
      attendanceStatus: 'invalid_status'
    };

    const attendance = new Attendance(invalidData);
    let err;
    try {
      await attendance.save();
    } catch (error) {
      err = error;
    }

    expect(err).toBeDefined();
    expect(err.errors.attendanceStatus).toBeDefined();
  });
});
