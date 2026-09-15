const mongoose = require('mongoose');
const Enrollment = require('../../../src/models/enrollment.model');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { buildEnrollment } = require('../../fixtures/enrollment.fixture');

describe('Enrollment Model Unit Tests', () => {
  beforeAll(async () => {
    await connectDB();
    await Enrollment.init();
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  test('should successfully create & save a valid enrollment', async () => {
    const data = buildEnrollment(new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), {
      enrollmentType: 'free'
    });

    const enrollment = new Enrollment(data);
    const saved = await enrollment.save();

    expect(saved._id).toBeDefined();
    expect(saved.status).toBe('active');
    expect(saved.progressPercentage).toBe(0);

    const json = saved.toJSON();
    expect(json.id).toBeDefined();
    expect(json._id).toBeUndefined();
  });

  test('should fail validation when enrollmentType is missing', async () => {
    const data = {
      userId: new mongoose.Types.ObjectId(),
      courseId: new mongoose.Types.ObjectId()
    };

    const enrollment = new Enrollment(data);
    let err;
    try {
      await enrollment.save();
    } catch (error) {
      err = error;
    }

    expect(err).toBeDefined();
    expect(err.errors.enrollmentType).toBeDefined();
  });

  test('should enforce unique constraint on active user-course enrollment', async () => {
    const userId = new mongoose.Types.ObjectId();
    const courseId = new mongoose.Types.ObjectId();

    const first = new Enrollment(buildEnrollment(userId, courseId, { enrollmentType: 'free' }));
    await first.save();

    const second = new Enrollment(buildEnrollment(userId, courseId, { enrollmentType: 'free' }));
    let err;
    try {
      await second.save();
    } catch (error) {
      err = error;
    }

    expect(err).toBeDefined();
    expect(err.code).toBe(11000);
  });
});
