const mongoose = require('mongoose');
const { requireEnrollment } = require('../../../src/middlewares/enrollment.middleware');
const Enrollment = require('../../../src/models/enrollment.model');
const { ApiError } = require('../../../src/utils/errors');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { buildEnrollment } = require('../../fixtures/enrollment.fixture');

describe('Enrollment Middleware Unit Tests', () => {
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

  test('should call next() when user has an active enrollment for the course', async () => {
    const userId = new mongoose.Types.ObjectId();
    const courseId = new mongoose.Types.ObjectId();

    await new Enrollment(buildEnrollment(userId, courseId, { status: 'active' })).save();

    const req = {
      user: { _id: userId },
      params: { courseId: courseId.toString() }
    };
    const res = {};
    const next = jest.fn();

    await requireEnrollment(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  test('should reject with 403 COURSE_ENROLLMENT_REQUIRED if user has no enrollment', async () => {
    const userId = new mongoose.Types.ObjectId();
    const courseId = new mongoose.Types.ObjectId();

    const req = {
      user: { _id: userId },
      params: { courseId: courseId.toString() }
    };
    const res = {};
    const next = jest.fn();

    await requireEnrollment(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('COURSE_ENROLLMENT_REQUIRED');
  });

  test('should reject with 403 COURSE_ENROLLMENT_REQUIRED if enrollment is cancelled or refunded', async () => {
    const userId = new mongoose.Types.ObjectId();
    const courseId = new mongoose.Types.ObjectId();

    await new Enrollment(buildEnrollment(userId, courseId, { status: 'cancelled' })).save();

    const req = {
      user: { _id: userId },
      params: { courseId: courseId.toString() }
    };
    const res = {};
    const next = jest.fn();

    await requireEnrollment(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('COURSE_ENROLLMENT_REQUIRED');
  });

  test('should call next(error) if database query throws an error', async () => {
    const spy = jest.spyOn(Enrollment, 'findOne').mockRejectedValueOnce(new Error('Database error'));

    const req = {
      user: { _id: new mongoose.Types.ObjectId() },
      params: { courseId: new mongoose.Types.ObjectId().toString() }
    };
    const res = {};
    const next = jest.fn();

    await requireEnrollment(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.message).toBe('Database error');

    spy.mockRestore();
  });
});
