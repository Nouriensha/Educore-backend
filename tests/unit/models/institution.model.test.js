const mongoose = require('mongoose');
const Institution = require('../../../src/models/institution.model');
const InstitutionAdmin = require('../../../src/models/institutionAdmin.model');
const InstitutionFeePlan = require('../../../src/models/institutionFeePlan.model');
const InstitutionMembership = require('../../../src/models/institutionMembership.model');
const InstitutionSettings = require('../../../src/models/institutionSettings.model');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');

describe('Institution Related Models Unit Tests', () => {
  beforeAll(async () => {
    await connectDB();
    await Institution.init();
    await InstitutionAdmin.init();
    await InstitutionFeePlan.init();
    await InstitutionMembership.init();
    await InstitutionSettings.init();
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  describe('Institution Model', () => {
    test('should create and save a valid institution', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const inst = new Institution({
        name: 'Tech University',
        domain: 'tech.edu',
        email: 'info@tech.edu',
        owner: ownerId
      });
      const saved = await inst.save();

      expect(saved._id).toBeDefined();
      expect(saved.name).toBe('Tech University');
      expect(saved.domain).toBe('tech.edu');
      expect(saved.status).toBe('active');
      expect(saved.isPublished).toBe(true);
      expect(saved.acceptsEnrollments).toBe(true);
    });

    test('should fail validation when required fields (name, domain, email, owner) are missing', async () => {
      const inst = new Institution({});
      let err;
      try {
        await inst.save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.errors.name).toBeDefined();
      expect(err.errors.domain).toBeDefined();
      expect(err.errors.email).toBeDefined();
      expect(err.errors.owner).toBeDefined();
    });

    test('should enforce unique domain constraint', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      await new Institution({
        name: 'Inst 1',
        domain: 'unique.edu',
        email: 'one@unique.edu',
        owner: ownerId
      }).save();

      let err;
      try {
        await new Institution({
          name: 'Inst 2',
          domain: 'unique.edu',
          email: 'two@unique.edu',
          owner: ownerId
        }).save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.code).toBe(11000);
    });
  });

  describe('InstitutionAdmin Model', () => {
    test('should create and format toJSON correctly', async () => {
      const admin = new InstitutionAdmin({
        institutionId: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId()
      });
      const saved = await admin.save();
      const json = saved.toJSON();

      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
      expect(json.__v).toBeUndefined();
    });

    test('should enforce unique compound index on institutionId and userId', async () => {
      const institutionId = new mongoose.Types.ObjectId();
      const userId = new mongoose.Types.ObjectId();

      await new InstitutionAdmin({ institutionId, userId }).save();
      let err;
      try {
        await new InstitutionAdmin({ institutionId, userId }).save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.code).toBe(11000);
    });
  });

  describe('InstitutionFeePlan Model', () => {
    test('should create and save valid fee plan with defaults', async () => {
      const plan = new InstitutionFeePlan({
        institutionId: new mongoose.Types.ObjectId(),
        registrationFee: 500,
        monthlyFee: 1000
      });
      const saved = await plan.save();

      expect(saved.currency).toBe('INR');
      expect(saved.paymentRequired).toBe(false);
      expect(saved.active).toBe(true);

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });

    test('should enforce unique active fee plan per institution', async () => {
      const institutionId = new mongoose.Types.ObjectId();
      await new InstitutionFeePlan({ institutionId, active: true }).save();

      let err;
      try {
        await new InstitutionFeePlan({ institutionId, active: true }).save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.code).toBe(11000);
    });
  });

  describe('InstitutionMembership Model', () => {
    test('should validate memberType enum and status defaults', async () => {
      const membership = new InstitutionMembership({
        institutionId: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
        memberType: 'learner'
      });
      const saved = await membership.save();

      expect(saved.status).toBe('active');
      expect(saved.paymentStatus).toBe('not_required');

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
    });

    test('should reject invalid memberType enum value', async () => {
      const membership = new InstitutionMembership({
        institutionId: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
        memberType: 'superadmin'
      });
      let err;
      try {
        await membership.save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.errors.memberType).toBeDefined();
    });
  });

  describe('InstitutionSettings Model', () => {
    test('should save institution settings and transform toJSON', async () => {
      const settings = new InstitutionSettings({
        institutionId: new mongoose.Types.ObjectId(),
        allowPublicCourses: false
      });
      const saved = await settings.save();
      expect(saved.allowPublicCourses).toBe(false);

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });
  });
});
