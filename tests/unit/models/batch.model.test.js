const mongoose = require('mongoose');
const Batch = require('../../../src/models/batch.model');
const EnrollmentRequest = require('../../../src/models/enrollmentRequest.model');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');

describe('Batch & Enrollment Request Model Unit Tests', () => {
  beforeAll(async () => {
    await connectDB();
    await Batch.init();
    await EnrollmentRequest.init();
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  describe('Batch Model', () => {
    test('should create a batch and compute studentCount in toJSON', async () => {
      const institutionId = new mongoose.Types.ObjectId();
      const student1 = new mongoose.Types.ObjectId();
      const student2 = new mongoose.Types.ObjectId();

      const batch = new Batch({
        institutionId,
        name: 'Batch Alpha 2026',
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-06-30'),
        students: [
          { userId: student1 },
          { userId: student2 }
        ]
      });
      const saved = await batch.save();
      expect(saved.status).toBe('active');

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json.studentCount).toBe(2);
      expect(json._id).toBeUndefined();
    });

    test('should enforce unique batch name per institution when not deleted', async () => {
      const institutionId = new mongoose.Types.ObjectId();

      await new Batch({
        institutionId,
        name: 'Batch 101',
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-06-30')
      }).save();

      let err;
      try {
        await new Batch({
          institutionId,
          name: 'Batch 101',
          startDate: new Date('2026-01-01'),
          endDate: new Date('2026-06-30')
        }).save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.code).toBe(11000);
    });

    test('should reject invalid batch status enum', async () => {
      const batch = new Batch({
        institutionId: new mongoose.Types.ObjectId(),
        name: 'Invalid Batch',
        startDate: new Date(),
        endDate: new Date(),
        status: 'expired'
      });
      let err;
      try {
        await batch.save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.errors.status).toBeDefined();
    });
  });

  describe('EnrollmentRequest Model', () => {
    test('should create valid enrollment request', async () => {
      const reqDoc = new EnrollmentRequest({
        userId: new mongoose.Types.ObjectId(),
        institutionId: new mongoose.Types.ObjectId(),
        feeSnapshot: {
          registrationFee: 100,
          joiningFee: 200,
          monthlyFee: 500,
          totalInitialCost: 800
        },
        expiresAt: new Date(Date.now() + 86400000)
      });
      const saved = await reqDoc.save();

      expect(saved._id).toBeDefined();
      expect(saved.status).toBe('pending_payment');
      expect(saved.feeSnapshot.totalInitialCost).toBe(800);
    });

    test('should fail validation when feeSnapshot or expiresAt is missing', async () => {
      const reqDoc = new EnrollmentRequest({
        userId: new mongoose.Types.ObjectId(),
        institutionId: new mongoose.Types.ObjectId()
      });
      let err;
      try {
        await reqDoc.save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.errors.expiresAt).toBeDefined();
    });
  });
});
