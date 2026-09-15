const mongoose = require('mongoose');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const InstitutionFeePlan = require('../../../src/models/institutionFeePlan.model');
const Institution = require('../../../src/models/institution.model');
const User = require('../../../src/models/user.model');
const institutionFeeService = require('../../../src/services/institutionFee.service');
const auditService = require('../../../src/services/audit.service');
const { ApiError } = require('../../../src/utils/errors');

// Mock Audit Service
jest.mock('../../../src/services/audit.service', () => ({
  logAdminAction: jest.fn().mockResolvedValue({ success: true }),
  logAction: jest.fn().mockResolvedValue({ success: true })
}));

describe('Institution Fee Service Comprehensive Behavioral & Security Unit Tests', () => {
  let platformOwner;
  let superAdmin;
  let platformAdmin;
  let institutionAdminA;
  let institutionAdminB;
  let legacyAdminA;
  let tutorUser;
  let learnerUser;

  let institutionA;
  let institutionB;
  let suspendedInstitution;

  let startSessionSpy;

  beforeAll(async () => {
    await connectDB();
    await InstitutionFeePlan.init();
    startSessionSpy = jest.spyOn(mongoose, 'startSession').mockRejectedValue(new Error('Standalone mongod: replica set required for transactions'));
  });

  afterAll(async () => {
    if (startSessionSpy) startSessionSpy.mockRestore();
    await closeDB();
  });

  beforeEach(async () => {
    await clearDB();
    jest.clearAllMocks();

    // Setup Actors
    platformOwner = await User.create({
      name: 'Root Platform Owner',
      email: 'owner@platform.test',
      passwordHash: 'dummy_hash',
      role: 'platform_owner',
      status: 'active',
      emailVerified: true
    });

    superAdmin = await User.create({
      name: 'Super Admin User',
      email: 'super@platform.test',
      passwordHash: 'dummy_hash',
      role: 'super_admin',
      status: 'active',
      emailVerified: true
    });

    platformAdmin = await User.create({
      name: 'Platform Admin User',
      email: 'padmin@platform.test',
      passwordHash: 'dummy_hash',
      role: 'platform_admin',
      status: 'active',
      emailVerified: true
    });

    // Setup Institutions
    institutionA = await Institution.create({
      name: 'Apex Institute of Technology',
      domain: 'apex.edu',
      email: 'contact@apex.edu',
      code: 'APEX01',
      status: 'active',
      owner: platformOwner._id
    });

    institutionB = await Institution.create({
      name: 'Beacon College of Engineering',
      domain: 'beacon.edu',
      email: 'contact@beacon.edu',
      code: 'BEACON01',
      status: 'active',
      owner: platformOwner._id
    });

    suspendedInstitution = await Institution.create({
      name: 'Suspended Academy',
      domain: 'suspended.edu',
      email: 'contact@suspended.edu',
      code: 'SUSP01',
      status: 'suspended',
      owner: platformOwner._id
    });

    // Institution Admins
    institutionAdminA = await User.create({
      name: 'Admin Apex',
      email: 'admin@apex.edu',
      passwordHash: 'dummy_hash',
      role: 'institution_admin',
      institutionId: institutionA._id,
      status: 'active',
      emailVerified: true
    });

    legacyAdminA = await User.create({
      name: 'Legacy Admin Apex',
      email: 'legacy@apex.edu',
      passwordHash: 'dummy_hash',
      role: 'admin',
      institutionId: institutionA._id,
      status: 'active',
      emailVerified: true
    });

    institutionAdminB = await User.create({
      name: 'Admin Beacon',
      email: 'admin@beacon.edu',
      passwordHash: 'dummy_hash',
      role: 'institution_admin',
      institutionId: institutionB._id,
      status: 'active',
      emailVerified: true
    });

    tutorUser = await User.create({
      name: 'Apex Tutor',
      email: 'tutor@apex.edu',
      passwordHash: 'dummy_hash',
      role: 'tutor',
      institutionId: institutionA._id,
      status: 'active',
      emailVerified: true
    });

    learnerUser = await User.create({
      name: 'Apex Learner',
      email: 'learner@apex.edu',
      passwordHash: 'dummy_hash',
      role: 'learner',
      institutionId: institutionA._id,
      status: 'active',
      emailVerified: true
    });
  });

  // =========================================================================
  // 1. PUBLIC FEE PLAN ACCESS (getPublicFeePlan)
  // =========================================================================
  describe('getPublicFeePlan', () => {
    it('should return null when no fee plan exists for the institution', async () => {
      const plan = await institutionFeeService.getPublicFeePlan(institutionA._id);
      expect(plan).toBeNull();
    });

    it('should return null when institution only has inactive fee plans', async () => {
      await InstitutionFeePlan.create({
        institutionId: institutionA._id,
        registrationFee: 500,
        joiningFee: 1000,
        monthlyFee: 200,
        paymentRequired: true,
        currency: 'INR',
        active: false,
        version: 1
      });

      const plan = await institutionFeeService.getPublicFeePlan(institutionA._id);
      expect(plan).toBeNull();
    });

    it('should return the sanitized public projection of the active fee plan', async () => {
      await InstitutionFeePlan.create({
        institutionId: institutionA._id,
        registrationFee: 250,
        joiningFee: 1500,
        monthlyFee: 500,
        paymentRequired: true,
        currency: 'INR',
        active: true,
        version: 1,
        createdBy: institutionAdminA._id,
        updatedBy: institutionAdminA._id,
        changeReason: 'Initial setup'
      });

      const plan = await institutionFeeService.getPublicFeePlan(institutionA._id);

      expect(plan).toEqual({
        registrationFee: 250,
        joiningFee: 1500,
        monthlyFee: 500,
        paymentRequired: true,
        currency: 'INR'
      });

      // Sensitive / internal metadata must not be in the public projection
      expect(plan.id).toBeUndefined();
      expect(plan._id).toBeUndefined();
      expect(plan.version).toBeUndefined();
      expect(plan.createdBy).toBeUndefined();
      expect(plan.changeReason).toBeUndefined();
    });

    it('should handle zero fee values correctly in public plan projection', async () => {
      await InstitutionFeePlan.create({
        institutionId: institutionA._id,
        registrationFee: 0,
        joiningFee: 0,
        monthlyFee: 0,
        paymentRequired: false,
        currency: 'INR',
        active: true,
        version: 1
      });

      const plan = await institutionFeeService.getPublicFeePlan(institutionA._id);

      expect(plan).toEqual({
        registrationFee: 0,
        joiningFee: 0,
        monthlyFee: 0,
        paymentRequired: false,
        currency: 'INR'
      });
    });

    it('should strictly return the plan matching the specific institutionId', async () => {
      await InstitutionFeePlan.create({
        institutionId: institutionA._id,
        registrationFee: 100,
        joiningFee: 200,
        monthlyFee: 300,
        paymentRequired: true,
        currency: 'INR',
        active: true,
        version: 1
      });

      await InstitutionFeePlan.create({
        institutionId: institutionB._id,
        registrationFee: 500,
        joiningFee: 600,
        monthlyFee: 700,
        paymentRequired: false,
        currency: 'USD',
        active: true,
        version: 1
      });

      const planA = await institutionFeeService.getPublicFeePlan(institutionA._id);
      const planB = await institutionFeeService.getPublicFeePlan(institutionB._id);

      expect(planA.registrationFee).toBe(100);
      expect(planA.currency).toBe('INR');

      expect(planB.registrationFee).toBe(500);
      expect(planB.currency).toBe('USD');
    });
  });

  // =========================================================================
  // 2. AUTHORIZATION & TENANT ISOLATION (validateAdminContext)
  // =========================================================================
  describe('Authorization & Multi-Tenant Isolation', () => {
    it('should reject learners from accessing fee plan history (403 UNAUTHORIZED_FEE_ACCESS)', async () => {
      await expect(
        institutionFeeService.getFeePlanHistory({
          actor: learnerUser,
          institutionId: institutionA._id
        })
      ).rejects.toThrow('Unauthorized to manage fees for this institution');
    });

    it('should reject tutors from accessing fee plan history (403 UNAUTHORIZED_FEE_ACCESS)', async () => {
      await expect(
        institutionFeeService.getFeePlanHistory({
          actor: tutorUser,
          institutionId: institutionA._id
        })
      ).rejects.toThrow('Unauthorized to manage fees for this institution');
    });

    it('should reject institution_admin of Institution B attempting to access Institution A history (Cross-Tenant IDOR)', async () => {
      await expect(
        institutionFeeService.getFeePlanHistory({
          actor: institutionAdminB,
          institutionId: institutionA._id
        })
      ).rejects.toThrow('Unauthorized to manage fees for this institution');
    });

    it('should reject institution_admin of Institution B attempting to create plan for Institution A (Cross-Tenant IDOR)', async () => {
      await expect(
        institutionFeeService.createFeePlanVersion({
          actor: institutionAdminB,
          institutionId: institutionA._id,
          registrationFee: 500,
          joiningFee: 1000,
          monthlyFee: 300,
          changeReason: 'Malicious update'
        })
      ).rejects.toThrow('Unauthorized to manage fees for this institution');
    });

    it('should reject institution_admin of Institution B attempting to toggle payment requirement for Institution A', async () => {
      await expect(
        institutionFeeService.togglePaymentRequirement({
          actor: institutionAdminB,
          institutionId: institutionA._id,
          paymentRequired: true,
          changeReason: 'Malicious toggle'
        })
      ).rejects.toThrow('Unauthorized to manage fees for this institution');
    });

    it('should allow institution_admin of Institution A to manage fees for Institution A', async () => {
      const res = await institutionFeeService.getFeePlanHistory({
        actor: institutionAdminA,
        institutionId: institutionA._id
      });
      expect(res.message).toBe('Fee plan history retrieved');
      expect(res.data).toEqual([]);
    });

    it('should allow legacy admin role of Institution A to manage fees for Institution A', async () => {
      const res = await institutionFeeService.getFeePlanHistory({
        actor: legacyAdminA,
        institutionId: institutionA._id
      });
      expect(res.message).toBe('Fee plan history retrieved');
      expect(res.data).toEqual([]);
    });

    it('should allow platform_owner to manage fees across ANY institution', async () => {
      const resA = await institutionFeeService.getFeePlanHistory({
        actor: platformOwner,
        institutionId: institutionA._id
      });
      const resB = await institutionFeeService.getFeePlanHistory({
        actor: platformOwner,
        institutionId: institutionB._id
      });
      expect(resA.message).toBe('Fee plan history retrieved');
      expect(resB.message).toBe('Fee plan history retrieved');
    });

    it('should allow super_admin to manage fees across ANY institution', async () => {
      const res = await institutionFeeService.getFeePlanHistory({
        actor: superAdmin,
        institutionId: institutionA._id
      });
      expect(res.message).toBe('Fee plan history retrieved');
    });

    it('should allow platform_admin to manage fees across ANY institution', async () => {
      const res = await institutionFeeService.getFeePlanHistory({
        actor: platformAdmin,
        institutionId: institutionB._id
      });
      expect(res.message).toBe('Fee plan history retrieved');
    });
  });

  // =========================================================================
  // 3. FEE PLAN HISTORY (getFeePlanHistory)
  // =========================================================================
  describe('getFeePlanHistory', () => {
    it('should return empty data array when no plans exist', async () => {
      const res = await institutionFeeService.getFeePlanHistory({
        actor: institutionAdminA,
        institutionId: institutionA._id
      });

      expect(res.message).toBe('Fee plan history retrieved');
      expect(res.data).toEqual([]);
    });

    it('should return all versions ordered by version descending with populated createdBy/updatedBy', async () => {
      const v1 = await InstitutionFeePlan.create({
        institutionId: institutionA._id,
        registrationFee: 100,
        joiningFee: 500,
        monthlyFee: 100,
        version: 1,
        active: false,
        createdBy: institutionAdminA._id,
        updatedBy: institutionAdminA._id,
        changeReason: 'Version 1 setup'
      });

      const v2 = await InstitutionFeePlan.create({
        institutionId: institutionA._id,
        registrationFee: 200,
        joiningFee: 800,
        monthlyFee: 150,
        version: 2,
        active: false,
        createdBy: institutionAdminA._id,
        updatedBy: platformOwner._id,
        changeReason: 'Version 2 adjustment'
      });

      const v3 = await InstitutionFeePlan.create({
        institutionId: institutionA._id,
        registrationFee: 300,
        joiningFee: 1000,
        monthlyFee: 200,
        version: 3,
        active: true,
        createdBy: platformOwner._id,
        updatedBy: platformOwner._id,
        changeReason: 'Version 3 modern'
      });

      const res = await institutionFeeService.getFeePlanHistory({
        actor: institutionAdminA,
        institutionId: institutionA._id
      });

      expect(res.data).toHaveLength(3);
      expect(res.data[0].version).toBe(3);
      expect(res.data[1].version).toBe(2);
      expect(res.data[2].version).toBe(1);

      // Verify population of createdBy / updatedBy
      expect(res.data[0].createdBy.email).toBe('owner@platform.test');
      expect(res.data[0].createdBy.name).toBe('Root Platform Owner');
      expect(res.data[1].updatedBy.email).toBe('owner@platform.test');
      expect(res.data[2].createdBy.email).toBe('admin@apex.edu');
    });

    it('should strictly isolate history per institution', async () => {
      await InstitutionFeePlan.create({
        institutionId: institutionA._id,
        registrationFee: 100,
        joiningFee: 500,
        monthlyFee: 100,
        version: 1,
        active: true
      });

      await InstitutionFeePlan.create({
        institutionId: institutionB._id,
        registrationFee: 999,
        joiningFee: 999,
        monthlyFee: 999,
        version: 1,
        active: true
      });

      const resA = await institutionFeeService.getFeePlanHistory({
        actor: institutionAdminA,
        institutionId: institutionA._id
      });

      expect(resA.data).toHaveLength(1);
      expect(resA.data[0].registrationFee).toBe(100);
    });
  });

  // =========================================================================
  // 4. CREATE FEE PLAN VERSION (createFeePlanVersion)
  // =========================================================================
  describe('createFeePlanVersion', () => {
    it('should throw 404 INST_NOT_FOUND if institution does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      await expect(
        institutionFeeService.createFeePlanVersion({
          actor: platformOwner,
          institutionId: nonExistentId,
          registrationFee: 200,
          joiningFee: 500,
          monthlyFee: 100,
          changeReason: 'Non-existent target'
        })
      ).rejects.toThrow('Institution not found');
    });

    it('should throw 403 INST_SUSPENDED if target institution is suspended', async () => {
      await expect(
        institutionFeeService.createFeePlanVersion({
          actor: platformOwner,
          institutionId: suspendedInstitution._id,
          registrationFee: 200,
          joiningFee: 500,
          monthlyFee: 100,
          changeReason: 'Suspended institution attempt'
        })
      ).rejects.toThrow('Institution is suspended');
    });

    it('should create version 1 when no previous fee plan exists, setting active: true and paymentRequired: false default', async () => {
      const res = await institutionFeeService.createFeePlanVersion({
        actor: institutionAdminA,
        institutionId: institutionA._id,
        registrationFee: 150,
        joiningFee: 600,
        monthlyFee: 250,
        changeReason: 'First institutional fee structure'
      });

      expect(res.message).toBe('New fee plan version created and activated');
      expect(res.data.version).toBe(1);
      expect(res.data.active).toBe(true);
      expect(res.data.paymentRequired).toBe(false);
      expect(res.data.currency).toBe('INR');
      expect(res.data.registrationFee).toBe(150);
      expect(res.data.joiningFee).toBe(600);
      expect(res.data.monthlyFee).toBe(250);
      expect(res.data.effectiveTo).toBeNull();
      expect(res.data.createdBy.toString()).toBe(institutionAdminA._id.toString());
      expect(res.data.updatedBy.toString()).toBe(institutionAdminA._id.toString());
      expect(res.data.changeReason).toBe('First institutional fee structure');

      // Verify Persisted DB State
      const planInDb = await InstitutionFeePlan.findById(res.data._id);
      expect(planInDb).toBeTruthy();
      expect(planInDb.active).toBe(true);
      expect(planInDb.version).toBe(1);

      // Verify Audit Log
      expect(auditService.logAdminAction).toHaveBeenCalledWith({
        actorUserId: institutionAdminA._id,
        targetUserId: institutionAdminA._id,
        action: 'FEE_PLAN_CREATED',
        metadata: {
          institutionId: institutionA._id,
          feePlanId: planInDb._id,
          version: 1,
          oldValues: null,
          newValues: { registrationFee: 150, joiningFee: 600, monthlyFee: 250 },
          reason: 'First institutional fee structure'
        }
      });
    });

    it('should create version 2, deactivating version 1, inheriting paymentRequired & currency, and logging audits', async () => {
      // Step 1: Create v1 with paymentRequired = true
      const v1Plan = await InstitutionFeePlan.create({
        institutionId: institutionA._id,
        registrationFee: 100,
        joiningFee: 500,
        monthlyFee: 200,
        paymentRequired: true,
        currency: 'USD',
        active: true,
        version: 1,
        createdBy: institutionAdminA._id,
        updatedBy: institutionAdminA._id
      });

      // Step 2: Create v2
      const res = await institutionFeeService.createFeePlanVersion({
        actor: institutionAdminA,
        institutionId: institutionA._id,
        registrationFee: 250,
        joiningFee: 750,
        monthlyFee: 350,
        changeReason: 'Annual inflation increase'
      });

      expect(res.message).toBe('New fee plan version created and activated');
      expect(res.data.version).toBe(2);
      expect(res.data.active).toBe(true);
      expect(res.data.paymentRequired).toBe(true); // Inherited from v1
      expect(res.data.currency).toBe('USD'); // Inherited from v1

      // Verify v1 in DB is deactivated
      const updatedV1 = await InstitutionFeePlan.findById(v1Plan._id);
      expect(updatedV1.active).toBe(false);
      expect(updatedV1.effectiveTo).toBeInstanceOf(Date);
      expect(updatedV1.updatedBy.toString()).toBe(institutionAdminA._id.toString());

      // Verify v2 in DB is active
      const updatedV2 = await InstitutionFeePlan.findById(res.data._id);
      expect(updatedV2.active).toBe(true);
      expect(updatedV2.version).toBe(2);

      // Verify Audit Actions: FEE_PLAN_DEACTIVATED followed by FEE_PLAN_UPDATED
      expect(auditService.logAdminAction).toHaveBeenCalledWith({
        actorUserId: institutionAdminA._id,
        targetUserId: institutionAdminA._id,
        action: 'FEE_PLAN_DEACTIVATED',
        metadata: {
          institutionId: institutionA._id,
          feePlanId: v1Plan._id,
          version: 1
        }
      });

      expect(auditService.logAdminAction).toHaveBeenCalledWith({
        actorUserId: institutionAdminA._id,
        targetUserId: institutionAdminA._id,
        action: 'FEE_PLAN_UPDATED',
        metadata: {
          institutionId: institutionA._id,
          feePlanId: updatedV2._id,
          version: 2,
          oldValues: {
            registrationFee: 100,
            joiningFee: 500,
            monthlyFee: 200
          },
          newValues: { registrationFee: 250, joiningFee: 750, monthlyFee: 350 },
          reason: 'Annual inflation increase'
        }
      });
    });

    it('should enforce partial unique index: only ONE active fee plan can exist per institution', async () => {
      // Create active plan
      await InstitutionFeePlan.create({
        institutionId: institutionA._id,
        registrationFee: 100,
        joiningFee: 500,
        monthlyFee: 100,
        active: true,
        version: 1
      });

      // Directly creating another active plan without deactivating should violate unique index
      let duplicateError;
      try {
        await InstitutionFeePlan.create({
          institutionId: institutionA._id,
          registrationFee: 200,
          joiningFee: 600,
          monthlyFee: 200,
          active: true,
          version: 2
        });
      } catch (err) {
        duplicateError = err;
      }

      expect(duplicateError).toBeDefined();
      expect(duplicateError.code).toBe(11000);
    });

    it('should abort transaction and throw if an error occurs inside the transaction runner', async () => {
      const saveSpy = jest.spyOn(InstitutionFeePlan.prototype, 'save').mockRejectedValueOnce(new Error('Disk write error'));

      await expect(
        institutionFeeService.createFeePlanVersion({
          actor: institutionAdminA,
          institutionId: institutionA._id,
          registrationFee: 100,
          joiningFee: 200,
          monthlyFee: 300,
          changeReason: 'Will fail'
        })
      ).rejects.toThrow('Disk write error');

      saveSpy.mockRestore();

      // Ensure no phantom plan was persisted
      const plans = await InstitutionFeePlan.find({ institutionId: institutionA._id });
      expect(plans).toHaveLength(0);
    });

    it('should operate cleanly when startSession throws or returns null (fallback non-transactional mode)', async () => {
      const res = await institutionFeeService.createFeePlanVersion({
        actor: institutionAdminA,
        institutionId: institutionA._id,
        registrationFee: 400,
        joiningFee: 800,
        monthlyFee: 120,
        changeReason: 'Fallback mode test'
      });

      expect(res.message).toBe('New fee plan version created and activated');
      expect(res.data.version).toBe(1);
    });

    it('should support boundary fee amounts including exact zero and large decimal amounts', async () => {
      const res = await institutionFeeService.createFeePlanVersion({
        actor: institutionAdminA,
        institutionId: institutionA._id,
        registrationFee: 0,
        joiningFee: 99999.99,
        monthlyFee: 49.5,
        changeReason: 'Boundary test'
      });

      expect(res.data.registrationFee).toBe(0);
      expect(res.data.joiningFee).toBe(99999.99);
      expect(res.data.monthlyFee).toBe(49.5);
    });
  });

  // =========================================================================
  // 5. TOGGLE PAYMENT REQUIREMENT (togglePaymentRequirement)
  // =========================================================================
  describe('togglePaymentRequirement', () => {
    it('should throw 404 INST_NOT_FOUND if institution does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      await expect(
        institutionFeeService.togglePaymentRequirement({
          actor: platformOwner,
          institutionId: nonExistentId,
          paymentRequired: true,
          changeReason: 'Non-existent target'
        })
      ).rejects.toThrow('Institution not found');
    });

    it('should throw 403 INST_SUSPENDED if institution is suspended', async () => {
      await expect(
        institutionFeeService.togglePaymentRequirement({
          actor: platformOwner,
          institutionId: suspendedInstitution._id,
          paymentRequired: true,
          changeReason: 'Suspended institution target'
        })
      ).rejects.toThrow('Institution is suspended');
    });

    it('should throw 404 FEE_PLAN_MISSING if institution has no active fee plan', async () => {
      await expect(
        institutionFeeService.togglePaymentRequirement({
          actor: institutionAdminA,
          institutionId: institutionA._id,
          paymentRequired: true,
          changeReason: 'No plan exists yet'
        })
      ).rejects.toThrow('No active fee plan found. Create a fee plan first.');
    });

    it('should return idempotent response without audit log if paymentRequired is already the requested state', async () => {
      const activePlan = await InstitutionFeePlan.create({
        institutionId: institutionA._id,
        registrationFee: 100,
        joiningFee: 500,
        monthlyFee: 100,
        paymentRequired: true,
        active: true,
        version: 1
      });

      const res = await institutionFeeService.togglePaymentRequirement({
        actor: institutionAdminA,
        institutionId: institutionA._id,
        paymentRequired: true,
        changeReason: 'Redundant toggle'
      });

      expect(res.message).toBe('Payment requirement is already set to requested state');
      expect(res.data.paymentRequired).toBe(true);

      // Audit should NOT be called on no-op
      expect(auditService.logAdminAction).not.toHaveBeenCalled();

      // DB state unchanged
      const planInDb = await InstitutionFeePlan.findById(activePlan._id);
      expect(planInDb.paymentRequired).toBe(true);
    });

    it('should toggle paymentRequired from false to true, save updatedBy/changeReason, and log audit', async () => {
      const activePlan = await InstitutionFeePlan.create({
        institutionId: institutionA._id,
        registrationFee: 200,
        joiningFee: 800,
        monthlyFee: 150,
        paymentRequired: false,
        active: true,
        version: 1,
        createdBy: institutionAdminA._id,
        updatedBy: institutionAdminA._id
      });

      const res = await institutionFeeService.togglePaymentRequirement({
        actor: institutionAdminA,
        institutionId: institutionA._id,
        paymentRequired: true,
        changeReason: 'Enabling paid tier enrollments'
      });

      expect(res.message).toBe('Payment requirement updated successfully');
      expect(res.data.paymentRequired).toBe(true);

      // Verify Persisted DB State
      const updatedInDb = await InstitutionFeePlan.findById(activePlan._id);
      expect(updatedInDb.paymentRequired).toBe(true);
      expect(updatedInDb.updatedBy.toString()).toBe(institutionAdminA._id.toString());
      expect(updatedInDb.changeReason).toBe('Enabling paid tier enrollments');

      // Verify Audit Action
      expect(auditService.logAdminAction).toHaveBeenCalledWith({
        actorUserId: institutionAdminA._id,
        targetUserId: institutionAdminA._id,
        action: 'PAYMENT_REQUIREMENT_CHANGED',
        metadata: {
          institutionId: institutionA._id,
          feePlanId: activePlan._id,
          version: 1,
          oldValues: { paymentRequired: false },
          newValues: { paymentRequired: true },
          reason: 'Enabling paid tier enrollments'
        }
      });
    });

    it('should toggle paymentRequired from true to false, save updatedBy/changeReason, and log audit', async () => {
      const activePlan = await InstitutionFeePlan.create({
        institutionId: institutionA._id,
        registrationFee: 200,
        joiningFee: 800,
        monthlyFee: 150,
        paymentRequired: true,
        active: true,
        version: 2,
        createdBy: institutionAdminA._id,
        updatedBy: institutionAdminA._id
      });

      const res = await institutionFeeService.togglePaymentRequirement({
        actor: institutionAdminA,
        institutionId: institutionA._id,
        paymentRequired: false,
        changeReason: 'Transitioning to free model'
      });

      expect(res.message).toBe('Payment requirement updated successfully');
      expect(res.data.paymentRequired).toBe(false);

      // Verify DB State
      const updatedInDb = await InstitutionFeePlan.findById(activePlan._id);
      expect(updatedInDb.paymentRequired).toBe(false);

      // Verify Audit Action
      expect(auditService.logAdminAction).toHaveBeenCalledWith({
        actorUserId: institutionAdminA._id,
        targetUserId: institutionAdminA._id,
        action: 'PAYMENT_REQUIREMENT_CHANGED',
        metadata: {
          institutionId: institutionA._id,
          feePlanId: activePlan._id,
          version: 2,
          oldValues: { paymentRequired: true },
          newValues: { paymentRequired: false },
          reason: 'Transitioning to free model'
        }
      });
    });

    it('should abort transaction and throw if an error occurs during toggle execution', async () => {
      await InstitutionFeePlan.create({
        institutionId: institutionA._id,
        registrationFee: 100,
        joiningFee: 500,
        monthlyFee: 100,
        paymentRequired: false,
        active: true,
        version: 1
      });

      const saveSpy = jest.spyOn(InstitutionFeePlan.prototype, 'save').mockRejectedValueOnce(new Error('Toggle save failed'));

      await expect(
        institutionFeeService.togglePaymentRequirement({
          actor: institutionAdminA,
          institutionId: institutionA._id,
          paymentRequired: true,
          changeReason: 'Will fail'
        })
      ).rejects.toThrow('Toggle save failed');

      saveSpy.mockRestore();

      // State should remain unchanged
      const planInDb = await InstitutionFeePlan.findOne({ institutionId: institutionA._id, active: true });
      expect(planInDb.paymentRequired).toBe(false);
    });
  });

  // =========================================================================
  // 6. HISTORICAL SNAPSHOT & MULTI-VERSION INTEGRITY
  // =========================================================================
  describe('Historical Snapshot & In-Flight Integrity', () => {
    it('should preserve deactivated plan historical values without modification when newer versions are created', async () => {
      // Create v1
      const v1Res = await institutionFeeService.createFeePlanVersion({
        actor: institutionAdminA,
        institutionId: institutionA._id,
        registrationFee: 100,
        joiningFee: 500,
        monthlyFee: 150,
        changeReason: 'v1 initial'
      });
      const v1Id = v1Res.data._id;

      // Create v2 with completely different fees
      const v2Res = await institutionFeeService.createFeePlanVersion({
        actor: institutionAdminA,
        institutionId: institutionA._id,
        registrationFee: 300,
        joiningFee: 1200,
        monthlyFee: 450,
        changeReason: 'v2 upgrade'
      });
      const v2Id = v2Res.data._id;

      // Verify v1 historical record remains completely intact
      const v1Doc = await InstitutionFeePlan.findById(v1Id);
      expect(v1Doc.active).toBe(false);
      expect(v1Doc.version).toBe(1);
      expect(v1Doc.registrationFee).toBe(100);
      expect(v1Doc.joiningFee).toBe(500);
      expect(v1Doc.monthlyFee).toBe(150);
      expect(v1Doc.changeReason).toBe('v1 initial');
      expect(v1Doc.effectiveTo).toBeInstanceOf(Date);

      // Verify v2 is the active plan
      const v2Doc = await InstitutionFeePlan.findById(v2Id);
      expect(v2Doc.active).toBe(true);
      expect(v2Doc.version).toBe(2);
      expect(v2Doc.registrationFee).toBe(300);
      expect(v2Doc.joiningFee).toBe(1200);
      expect(v2Doc.monthlyFee).toBe(450);
      expect(v2Doc.effectiveTo).toBeNull();
    });
  });
});
