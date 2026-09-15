const mongoose = require('mongoose');
const Certificate = require('../../../src/models/certificate.model');
const CertificateTemplate = require('../../../src/models/certificateTemplate.model');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');

describe('Certificate Related Models Unit Tests', () => {
  beforeAll(async () => {
    await connectDB();
    await Certificate.init();
    await CertificateTemplate.init();
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  describe('Certificate Model', () => {
    test('should create valid certificate and format toJSON', async () => {
      const cert = new Certificate({
        userId: new mongoose.Types.ObjectId(),
        courseId: new mongoose.Types.ObjectId(),
        certificateNumber: 'CERT-2026-0001',
        status: 'issued'
      });
      const saved = await cert.save();

      expect(saved._id).toBeDefined();
      expect(saved.certificateNumber).toBe('CERT-2026-0001');

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });

    test('should enforce unique certificateNumber', async () => {
      const userId = new mongoose.Types.ObjectId();
      const courseId1 = new mongoose.Types.ObjectId();
      const courseId2 = new mongoose.Types.ObjectId();

      await new Certificate({
        userId,
        courseId: courseId1,
        certificateNumber: 'DUPLICATE-NUM'
      }).save();

      let err;
      try {
        await new Certificate({
          userId,
          courseId: courseId2,
          certificateNumber: 'DUPLICATE-NUM'
        }).save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.code).toBe(11000);
    });

    test('should reject invalid certificate status enum', async () => {
      const cert = new Certificate({
        userId: new mongoose.Types.ObjectId(),
        courseId: new mongoose.Types.ObjectId(),
        certificateNumber: 'CERT-FAIL',
        status: 'invalid_status'
      });
      let err;
      try {
        await cert.save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.errors.status).toBeDefined();
    });
  });

  describe('CertificateTemplate Model', () => {
    test('should save valid certificate template and format toJSON', async () => {
      const template = new CertificateTemplate({
        name: 'Standard Excellence',
        scope: 'platform',
        createdBy: new mongoose.Types.ObjectId(),
        updatedBy: new mongoose.Types.ObjectId()
      });
      const saved = await template.save();

      expect(saved.version).toBe(1);
      expect(saved.isActive).toBe(true);

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });

    test('should fail validation when name, scope, createdBy, or updatedBy are missing', async () => {
      const template = new CertificateTemplate({});
      let err;
      try {
        await template.save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.errors.name).toBeDefined();
      expect(err.errors.scope).toBeDefined();
    });
  });
});
