const mongoose = require('mongoose');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const institutionService = require('../../../src/services/institution.service');
const notificationService = require('../../../src/services/notification.service');
const auditService = require('../../../src/services/audit.service');

const User = require('../../../src/models/user.model');
const Institution = require('../../../src/models/institution.model');
const Batch = require('../../../src/models/batch.model');
const Course = require('../../../src/models/course.model');
const Enrollment = require('../../../src/models/enrollment.model');
const Attendance = require('../../../src/models/attendance.model');
const LiveSession = require('../../../src/models/liveSession.model');
const TutorAssignment = require('../../../src/models/tutorAssignment.model');
const InstitutionMembership = require('../../../src/models/institutionMembership.model');
const InstitutionSettings = require('../../../src/models/institutionSettings.model');
const AuditLog = require('../../../src/models/auditLog.model');

const { buildUser } = require('../../fixtures/user.fixture');

const createTestInstitution = async (overrides = {}) => {
  const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  return await Institution.create({
    name: `Test Institution ${unique}`,
    domain: `inst-${unique}.edu`,
    email: `inst_${unique}@example.com`,
    address: '123 Tech Blvd, City',
    owner: new mongoose.Types.ObjectId(),
    status: 'active',
    ...overrides
  });
};

describe('Institution Service Comprehensive Unit Tests', () => {
  let instAdminUser;
  let institutionId;
  let defaultInstitution;

  beforeAll(async () => {
    await connectDB();
    await TutorAssignment.init();
    await Batch.init();
    await Attendance.init();
    await InstitutionMembership.init();
    await InstitutionSettings.init();
  });

  afterAll(async () => {
    await closeDB();
  });

  beforeEach(async () => {
    jest.spyOn(mongoose, 'startSession').mockRejectedValue(new Error('Standalone Mongo'));
    jest.spyOn(notificationService, 'createNotification').mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
    jest.spyOn(auditService, 'logAdminAction').mockImplementation(async (params) => {
      return await AuditLog.create({
        actorUserId: params.actorUserId,
        targetUserId: params.targetUserId,
        action: params.action,
        metadata: params.metadata || {},
        ip: '127.0.0.1',
        userAgent: 'test-agent'
      });
    });

    defaultInstitution = await createTestInstitution();
    institutionId = defaultInstitution._id;

    instAdminUser = await User.create(
      buildUser({
        name: 'Institution Admin',
        email: `admin_${Date.now()}@inst.com`,
        role: 'institution_admin',
        institutionId,
        status: 'active'
      })
    );
  });

  afterEach(async () => {
    await clearDB();
    jest.restoreAllMocks();
  });

  // =========================================================================
  // 1. getInstitutionContext
  // =========================================================================
  describe('getInstitutionContext', () => {
    test('should return actorUser and institutionId for valid institution admin', async () => {
      const context = await institutionService.getInstitutionContext(instAdminUser);
      expect(context.institutionId.toString()).toBe(institutionId.toString());
      expect(context.actorUser._id.toString()).toBe(instAdminUser._id.toString());
    });

    test('should throw 401 USER_NOT_FOUND if actor user does not exist or is soft deleted', async () => {
      const deletedUser = await User.create(
        buildUser({
          email: 'deleted@inst.com',
          institutionId,
          deletedAt: new Date()
        })
      );

      await expect(institutionService.getInstitutionContext(deletedUser)).rejects.toMatchObject({
        statusCode: 401,
        code: 'USER_NOT_FOUND'
      });
    });

    test('should throw 403 INSTITUTION_REQUIRED if user has no institutionId', async () => {
      const orphanUser = await User.create(
        buildUser({
          email: 'orphan@inst.com',
          institutionId: null
        })
      );

      await expect(institutionService.getInstitutionContext(orphanUser)).rejects.toMatchObject({
        statusCode: 403,
        code: 'INSTITUTION_REQUIRED'
      });
    });
  });

  // =========================================================================
  // 2. getDashboard
  // =========================================================================
  describe('getDashboard', () => {
    test('should return default zeroes and empty arrays when institution has no activity', async () => {
      const res = await institutionService.getDashboard({ actor: instAdminUser });
      expect(res.message).toBe('Institution dashboard retrieved successfully');
      expect(res.data.kpis).toEqual({
        totalStudents: 0,
        activeBatches: 0,
        activeTutors: 0,
        averageCompletionRate: 0
      });
      expect(res.data.recentEnrollmentActivity).toEqual([]);
      expect(res.data.upcomingLiveSessions).toEqual([]);
      expect(res.data.topPerformingCourses).toEqual([]);
    });

    test('should compute KPIs, recent enrollments, upcoming live sessions, and top courses', async () => {
      // Create learner and tutor
      const learner = await User.create(buildUser({ institutionId, role: 'learner', status: 'active' }));
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const course = await Course.create({
        title: 'Institution Course 101',
        slug: `inst-course-${Date.now()}`,
        description: 'Test course',
        category: 'Development',
        level: 'Beginner',
        authorId: tutor._id,
        institutionId
      });

      const batch = await Batch.create({
        institutionId,
        name: 'Alpha Batch',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 30),
        status: 'active',
        assignedTutorId: tutor._id
      });

      await Enrollment.create({
        userId: learner._id,
        courseId: course._id,
        institutionId,
        status: 'active',
        progressPercentage: 80,
        enrollmentType: 'admin_granted'
      });

      const futureDate = new Date(Date.now() + 3600000);
      await LiveSession.create({
        courseId: course._id,
        tutorId: tutor._id,
        batchId: batch._id,
        title: 'Live Q&A Session',
        startTime: futureDate,
        endTime: new Date(futureDate.getTime() + 3600000),
        timezone: 'UTC',
        durationMinutes: 60,
        status: 'scheduled'
      });

      const res = await institutionService.getDashboard({ actor: instAdminUser });
      expect(res.data.kpis.totalStudents).toBe(1);
      expect(res.data.kpis.activeBatches).toBe(1);
      expect(res.data.kpis.activeTutors).toBe(1);
      expect(res.data.kpis.averageCompletionRate).toBe(80);
      expect(res.data.recentEnrollmentActivity.length).toBe(1);
      expect(res.data.upcomingLiveSessions.length).toBe(1);
      expect(res.data.topPerformingCourses.length).toBe(1);
      expect(res.data.topPerformingCourses[0].title).toBe('Institution Course 101');
    });
  });

  // =========================================================================
  // 3. listBatches & getBatch
  // =========================================================================
  describe('listBatches & getBatch', () => {
    test('should list batches with status filter, search query, and pagination', async () => {
      await Batch.create({
        institutionId,
        name: 'Spring 2026 Batch',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 10),
        status: 'active'
      });
      await Batch.create({
        institutionId,
        name: 'Fall 2026 Batch',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 10),
        status: 'archived'
      });

      const activeRes = await institutionService.listBatches({
        actor: instAdminUser,
        query: { status: 'active', search: 'Spring', page: 1, limit: 10 }
      });
      expect(activeRes.data.batches.length).toBe(1);
      expect(activeRes.data.batches[0].name).toBe('Spring 2026 Batch');
      expect(activeRes.data.pagination.total).toBe(1);
    });

    test('should retrieve batch by ID with populated students and tutor', async () => {
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const learner = await User.create(buildUser({ institutionId, role: 'learner', status: 'active' }));
      const batch = await Batch.create({
        institutionId,
        name: 'Batch Beta',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 10),
        assignedTutorId: tutor._id,
        students: [{ userId: learner._id }]
      });

      const res = await institutionService.getBatch({ actor: instAdminUser, batchId: batch._id });
      expect(res.data.batch.name).toBe('Batch Beta');
      expect(res.data.batch.studentCount).toBe(1);
      expect(res.data.batch.assignedTutorId.name).toBe(tutor.name);
    });

    test('should throw 404 BATCH_NOT_FOUND for non-existent or cross-institution batch', async () => {
      const otherInst = await createTestInstitution();
      const otherBatch = await Batch.create({
        institutionId: otherInst._id,
        name: 'Other Batch',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 10)
      });

      await expect(
        institutionService.getBatch({ actor: instAdminUser, batchId: otherBatch._id })
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'BATCH_NOT_FOUND'
      });
    });
  });

  // =========================================================================
  // 4. createBatch & updateBatch
  // =========================================================================
  describe('createBatch & updateBatch', () => {
    test('should successfully create batch with assigned tutor and send notification', async () => {
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const startDate = new Date();
      const endDate = new Date(Date.now() + 86400000 * 14);

      const res = await institutionService.createBatch({
        actor: instAdminUser,
        payload: {
          name: 'Batch Delta',
          startDate,
          endDate,
          assignedTutorId: tutor._id
        }
      });

      expect(res.data.batch.name).toBe('Batch Delta');
      const assignment = await TutorAssignment.findOne({ batchId: res.data.batch.id, status: 'active' });
      expect(assignment).toBeTruthy();
      expect(assignment.tutorId.toString()).toBe(tutor._id.toString());
      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: tutor._id,
          title: 'New Batch Assignment'
        })
      );
    });

    test('should throw 400 INVALID_BATCH_DATES if endDate is earlier than startDate', async () => {
      await expect(
        institutionService.createBatch({
          actor: instAdminUser,
          payload: {
            name: 'Invalid Dates Batch',
            startDate: new Date(Date.now() + 100000),
            endDate: new Date(Date.now())
          }
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_BATCH_DATES'
      });
    });

    test('should throw 404 TUTOR_NOT_FOUND when assigning non-tutor or tutor from another institution', async () => {
      const externalTutor = await User.create(
        buildUser({ institutionId: new mongoose.Types.ObjectId(), role: 'tutor', status: 'active' })
      );

      await expect(
        institutionService.createBatch({
          actor: instAdminUser,
          payload: {
            name: 'Cross Tutor Batch',
            startDate: new Date(),
            endDate: new Date(Date.now() + 86400000),
            assignedTutorId: externalTutor._id
          }
        })
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'TUTOR_NOT_FOUND'
      });
    });

    test('should update batch properties and reassign tutor removing old assignment', async () => {
      const tutorA = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const tutorB = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const batch = await Batch.create({
        institutionId,
        name: 'Batch Gamma',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 20),
        assignedTutorId: tutorA._id
      });
      await TutorAssignment.create({
        institutionId,
        tutorId: tutorA._id,
        batchId: batch._id,
        assignmentType: 'batch',
        assignedBy: instAdminUser._id
      });

      const res = await institutionService.updateBatch({
        actor: instAdminUser,
        batchId: batch._id,
        payload: {
          name: 'Batch Gamma Renamed',
          assignedTutorId: tutorB._id
        }
      });

      expect(res.data.batch.name).toBe('Batch Gamma Renamed');
      const oldAssignment = await TutorAssignment.findOne({ tutorId: tutorA._id, batchId: batch._id });
      expect(oldAssignment.status).toBe('removed');

      const newAssignment = await TutorAssignment.findOne({ tutorId: tutorB._id, batchId: batch._id, status: 'active' });
      expect(newAssignment).toBeTruthy();
    });

    test('should throw 400 INVALID_BATCH_DATES if updateBatch sets endDate before startDate', async () => {
      const batch = await Batch.create({
        institutionId,
        name: 'Date Test Batch',
        startDate: new Date(Date.now() + 86400000),
        endDate: new Date(Date.now() + 86400000 * 2)
      });

      await expect(
        institutionService.updateBatch({
          actor: instAdminUser,
          batchId: batch._id,
          payload: { endDate: new Date(Date.now()) }
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_BATCH_DATES'
      });
    });
  });

  // =========================================================================
  // 5. addStudentsToBatch & removeStudentFromBatch
  // =========================================================================
  describe('addStudentsToBatch & removeStudentFromBatch', () => {
    test('should add learners via IDs, emails, objects, and CSV parsing, partitioning failures', async () => {
      const learner1 = await User.create(buildUser({ institutionId, role: 'learner', status: 'active', email: 'l1@inst.com' }));
      const learner2 = await User.create(buildUser({ institutionId, role: 'learner', status: 'active', email: 'l2@inst.com' }));
      const otherInstUser = await User.create(buildUser({ institutionId: new mongoose.Types.ObjectId(), role: 'learner', status: 'active', email: 'other@inst.com' }));
      const inactiveUser = await User.create(buildUser({ institutionId, role: 'learner', status: 'suspended', email: 'inactive@inst.com' }));
      const tutorUser = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active', email: 'tutor@inst.com' }));

      const batch = await Batch.create({
        institutionId,
        name: 'Enrollment Batch',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 30)
      });

      const csvContent = `email,studentId\nl2@inst.com,\nnonexistent@inst.com,`;

      const res = await institutionService.addStudentsToBatch({
        actor: instAdminUser,
        batchId: batch._id,
        payload: {
          studentIds: [learner1._id.toString()],
          emails: [otherInstUser.email, inactiveUser.email, tutorUser.email],
          csvContent
        }
      });

      expect(res.data.added.length).toBe(2); // learner1 and learner2
      expect(res.data.failed.length).toBeGreaterThanOrEqual(4); // otherInstUser, inactive, tutor, nonexistent

      const updatedBatch = await Batch.findById(batch._id);
      expect(updatedBatch.students.length).toBe(2);
    });

    test('should throw 400 NO_STUDENTS_PROVIDED if input contains zero students', async () => {
      const batch = await Batch.create({
        institutionId,
        name: 'Empty Batch',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 30)
      });

      await expect(
        institutionService.addStudentsToBatch({
          actor: instAdminUser,
          batchId: batch._id,
          payload: {}
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'NO_STUDENTS_PROVIDED'
      });
    });

    test('should successfully remove student from batch', async () => {
      const learner = await User.create(buildUser({ institutionId, role: 'learner', status: 'active' }));
      const batch = await Batch.create({
        institutionId,
        name: 'Removal Batch',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 30),
        students: [{ userId: learner._id }]
      });

      const res = await institutionService.removeStudentFromBatch({
        actor: instAdminUser,
        batchId: batch._id,
        studentId: learner._id
      });

      expect(res.data.batch.studentCount).toBe(0);
    });

    test('should throw 404 BATCH_STUDENT_NOT_FOUND if student is not in batch', async () => {
      const batch = await Batch.create({
        institutionId,
        name: 'Clean Batch',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 30)
      });

      await expect(
        institutionService.removeStudentFromBatch({
          actor: instAdminUser,
          batchId: batch._id,
          studentId: new mongoose.Types.ObjectId()
        })
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'BATCH_STUDENT_NOT_FOUND'
      });
    });
  });

  // =========================================================================
  // 6. archiveBatch & deleteBatch
  // =========================================================================
  describe('archiveBatch & deleteBatch', () => {
    test('should archive batch and set status to archived', async () => {
      const batch = await Batch.create({
        institutionId,
        name: 'Archivable Batch',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 30)
      });

      const res = await institutionService.archiveBatch({ actor: instAdminUser, batchId: batch._id });
      expect(res.data.batch.status).toBe('archived');
      const inDb = await Batch.findById(batch._id);
      expect(inDb.status).toBe('archived');
      expect(inDb.archivedAt).toBeTruthy();
    });

    test('should throw 409 BATCH_HAS_ACTIVE_SESSIONS when archiving batch with upcoming live sessions', async () => {
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const course = await Course.create({
        title: 'Active Session Course',
        slug: `course-${Date.now()}`,
        description: 'desc',
        category: 'Development',
        level: 'Beginner',
        authorId: tutor._id,
        institutionId
      });
      const batch = await Batch.create({
        institutionId,
        name: 'Live Blocked Batch',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 30)
      });

      const futureDate = new Date(Date.now() + 7200000);
      await LiveSession.create({
        courseId: course._id,
        tutorId: tutor._id,
        batchId: batch._id,
        title: 'Blocking Live Session',
        startTime: futureDate,
        endTime: new Date(futureDate.getTime() + 3600000),
        status: 'scheduled',
        timezone: 'UTC',
        durationMinutes: 60
      });

      await expect(
        institutionService.archiveBatch({ actor: instAdminUser, batchId: batch._id })
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'BATCH_HAS_ACTIVE_SESSIONS'
      });
    });

    test('should soft delete batch and cascade deactivation of tutor assignments', async () => {
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const batch = await Batch.create({
        institutionId,
        name: 'Deletable Batch',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 30),
        assignedTutorId: tutor._id
      });
      const assignment = await TutorAssignment.create({
        institutionId,
        tutorId: tutor._id,
        batchId: batch._id,
        assignmentType: 'batch',
        assignedBy: instAdminUser._id
      });

      const res = await institutionService.deleteBatch({ actor: instAdminUser, batchId: batch._id });
      expect(res.message).toBe('Batch deleted successfully');

      const inDb = await Batch.findById(batch._id);
      expect(inDb.deletedAt).toBeTruthy();

      const updatedAssignment = await TutorAssignment.findById(assignment._id);
      expect(updatedAssignment.status).toBe('removed');
      expect(updatedAssignment.metadata?.reason).toBe('BATCH_DELETED');
    });

    test('should throw 409 BATCH_HAS_ACTIVE_SESSIONS when deleting batch with upcoming live sessions', async () => {
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const course = await Course.create({
        title: 'Delete Blocked Course',
        slug: `del-course-${Date.now()}`,
        description: 'desc',
        category: 'Development',
        level: 'Beginner',
        authorId: tutor._id,
        institutionId
      });
      const batch = await Batch.create({
        institutionId,
        name: 'Delete Blocked Batch',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 30)
      });

      const futureDate = new Date(Date.now() + 7200000);
      await LiveSession.create({
        courseId: course._id,
        tutorId: tutor._id,
        batchId: batch._id,
        title: 'Delete Blocking Session',
        startTime: futureDate,
        endTime: new Date(futureDate.getTime() + 3600000),
        status: 'scheduled',
        timezone: 'UTC',
        durationMinutes: 60
      });

      await expect(
        institutionService.deleteBatch({ actor: instAdminUser, batchId: batch._id })
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'BATCH_HAS_ACTIVE_SESSIONS'
      });
    });
  });

  // =========================================================================
  // 7. listApprovedTutors & listTutorAssignments
  // =========================================================================
  describe('listApprovedTutors & listTutorAssignments', () => {
    test('should list approved tutors in institution and filter by search query', async () => {
      await User.create(buildUser({ institutionId, role: 'tutor', name: 'Albert Einstein', status: 'active' }));
      await User.create(buildUser({ institutionId, role: 'tutor', name: 'Marie Curie', status: 'active' }));
      await User.create(buildUser({ institutionId: new mongoose.Types.ObjectId(), role: 'tutor', name: 'External Tutor', status: 'active' }));

      const res = await institutionService.listApprovedTutors({
        actor: instAdminUser,
        query: { search: 'Einstein' }
      });

      expect(res.data.tutors.length).toBe(1);
      expect(res.data.tutors[0].name).toBe('Albert Einstein');
      expect(res.data.tutors[0].passwordHash).toBeUndefined();
    });

    test('should list tutor assignments filtered by tutorId, status, and assignmentType', async () => {
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      await TutorAssignment.create({
        institutionId,
        tutorId: tutor._id,
        courseId: new mongoose.Types.ObjectId(),
        assignmentType: 'course',
        status: 'active',
        assignedBy: instAdminUser._id
      });
      await TutorAssignment.create({
        institutionId,
        tutorId: tutor._id,
        batchId: new mongoose.Types.ObjectId(),
        assignmentType: 'batch',
        status: 'removed',
        assignedBy: instAdminUser._id
      });

      const res = await institutionService.listTutorAssignments({
        actor: instAdminUser,
        query: { tutorId: tutor._id.toString(), status: 'active', assignmentType: 'course' }
      });

      expect(res.data.assignments.length).toBe(1);
      expect(res.data.assignments[0].assignmentType).toBe('course');
    });
  });

  // =========================================================================
  // 8. createTutorAssignments & removeTutorAssignment
  // =========================================================================
  describe('createTutorAssignments & removeTutorAssignment', () => {
    test('should create course assignment, update course authorId, record audit log, and notify tutor', async () => {
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const course = await Course.create({
        title: 'Assigned Course',
        slug: `assigned-course-${Date.now()}`,
        description: 'desc',
        category: 'Development',
        level: 'Beginner',
        authorId: instAdminUser._id,
        institutionId
      });

      const res = await institutionService.createTutorAssignments({
        actor: instAdminUser,
        payload: {
          tutorId: tutor._id,
          courseIds: [course._id.toString()]
        }
      });

      expect(res.data.assignments.length).toBe(1);
      const updatedCourse = await Course.findById(course._id);
      expect(updatedCourse.authorId.toString()).toBe(tutor._id.toString());
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'TUTOR_ASSIGNED',
          targetUserId: tutor._id
        })
      );
      expect(notificationService.createNotification).toHaveBeenCalled();
    });

    test('should throw 400 NO_ASSIGNMENT_TARGETS when courseIds and batchIds are missing', async () => {
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      await expect(
        institutionService.createTutorAssignments({
          actor: instAdminUser,
          payload: { tutorId: tutor._id }
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'NO_ASSIGNMENT_TARGETS'
      });
    });

    test('should throw 404 COURSE_NOT_FOUND when courseId does not exist', async () => {
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      await expect(
        institutionService.createTutorAssignments({
          actor: instAdminUser,
          payload: {
            tutorId: tutor._id,
            courseIds: [new mongoose.Types.ObjectId().toString()]
          }
        })
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'COURSE_NOT_FOUND'
      });
    });

    test('should throw 403 COURSE_NOT_IN_INSTITUTION if course author does not belong to institution', async () => {
      const externalAuthor = await User.create(buildUser({ institutionId: new mongoose.Types.ObjectId(), role: 'tutor', status: 'active' }));
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const course = await Course.create({
        title: 'External Course',
        slug: `ext-course-${Date.now()}`,
        description: 'desc',
        category: 'Development',
        level: 'Beginner',
        authorId: externalAuthor._id
      });

      await expect(
        institutionService.createTutorAssignments({
          actor: instAdminUser,
          payload: {
            tutorId: tutor._id,
            courseIds: [course._id.toString()]
          }
        })
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'COURSE_NOT_IN_INSTITUTION'
      });
    });

    test('should remove course assignment, restore author, and write audit log', async () => {
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const previousAuthor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const course = await Course.create({
        title: 'Reversible Course',
        slug: `rev-course-${Date.now()}`,
        description: 'desc',
        category: 'Development',
        level: 'Beginner',
        authorId: tutor._id,
        institutionId
      });

      const assignment = await TutorAssignment.create({
        institutionId,
        tutorId: tutor._id,
        courseId: course._id,
        assignmentType: 'course',
        assignedBy: instAdminUser._id,
        metadata: { previousAuthorId: previousAuthor._id }
      });

      const res = await institutionService.removeTutorAssignment({
        actor: instAdminUser,
        assignmentId: assignment._id
      });

      expect(res.data.assignment.status).toBe('removed');
      const updatedCourse = await Course.findById(course._id);
      expect(updatedCourse.authorId.toString()).toBe(previousAuthor._id.toString());
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'TUTOR_REMOVED',
          targetUserId: tutor._id
        })
      );
    });

    test('should remove batch assignment and clear batch assignedTutorId', async () => {
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const batch = await Batch.create({
        institutionId,
        name: 'Batch to Unassign',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000),
        assignedTutorId: tutor._id
      });

      const assignment = await TutorAssignment.create({
        institutionId,
        tutorId: tutor._id,
        batchId: batch._id,
        assignmentType: 'batch',
        assignedBy: instAdminUser._id
      });

      await institutionService.removeTutorAssignment({
        actor: instAdminUser,
        assignmentId: assignment._id
      });

      const updatedBatch = await Batch.findById(batch._id);
      expect(updatedBatch.assignedTutorId).toBeNull();
    });

    test('should throw 404 ASSIGNMENT_NOT_FOUND when removing non-existent or cross-institution assignment', async () => {
      await expect(
        institutionService.removeTutorAssignment({
          actor: instAdminUser,
          assignmentId: new mongoose.Types.ObjectId()
        })
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'ASSIGNMENT_NOT_FOUND'
      });
    });
  });

  // =========================================================================
  // 9. getTutorAssignment & getTutorAssignmentHistory
  // =========================================================================
  describe('getTutorAssignment & getTutorAssignmentHistory', () => {
    test('should allow admin to view assignment in same institution', async () => {
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const assignment = await TutorAssignment.create({
        institutionId,
        tutorId: tutor._id,
        courseId: new mongoose.Types.ObjectId(),
        assignmentType: 'course',
        assignedBy: instAdminUser._id
      });

      const res = await institutionService.getTutorAssignment({
        actor: instAdminUser,
        assignmentId: assignment._id
      });
      expect(res.data.assignment._id.toString()).toBe(assignment._id.toString());
    });

    test('should reject admin attempting to view cross-institution assignment with 403 FORBIDDEN', async () => {
      const otherInst = await createTestInstitution();
      const tutor = await User.create(buildUser({ institutionId: otherInst._id, role: 'tutor', status: 'active' }));
      const assignment = await TutorAssignment.create({
        institutionId: otherInst._id,
        tutorId: tutor._id,
        courseId: new mongoose.Types.ObjectId(),
        assignmentType: 'course',
        assignedBy: new mongoose.Types.ObjectId()
      });

      await expect(
        institutionService.getTutorAssignment({ actor: instAdminUser, assignmentId: assignment._id })
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN'
      });
    });

    test('should allow tutor to view own assignment and reject viewing another tutors assignment', async () => {
      const tutorA = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const tutorB = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const assignment = await TutorAssignment.create({
        institutionId,
        tutorId: tutorA._id,
        courseId: new mongoose.Types.ObjectId(),
        assignmentType: 'course',
        assignedBy: instAdminUser._id
      });

      const ownRes = await institutionService.getTutorAssignment({
        actor: tutorA,
        assignmentId: assignment._id
      });
      expect(ownRes.data.assignment._id.toString()).toBe(assignment._id.toString());

      await expect(
        institutionService.getTutorAssignment({ actor: tutorB, assignmentId: assignment._id })
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN'
      });
    });

    test('should allow learner with active institution membership to view assigned tutor', async () => {
      const learner = await User.create(buildUser({ institutionId, role: 'learner', status: 'active' }));
      await InstitutionMembership.create({
        institutionId,
        userId: learner._id,
        memberType: 'learner',
        status: 'active'
      });

      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const assignment = await TutorAssignment.create({
        institutionId,
        tutorId: tutor._id,
        courseId: new mongoose.Types.ObjectId(),
        assignmentType: 'course',
        assignedBy: instAdminUser._id
      });

      const res = await institutionService.getTutorAssignment({
        actor: learner,
        assignmentId: assignment._id
      });
      expect(res.data.tutor._id.toString()).toBe(tutor._id.toString());
    });

    test('should reject learner without institution membership with 403 FORBIDDEN', async () => {
      const learner = await User.create(buildUser({ role: 'learner', status: 'active' }));
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const assignment = await TutorAssignment.create({
        institutionId,
        tutorId: tutor._id,
        courseId: new mongoose.Types.ObjectId(),
        assignmentType: 'course',
        assignedBy: instAdminUser._id
      });

      await expect(
        institutionService.getTutorAssignment({ actor: learner, assignmentId: assignment._id })
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN'
      });
    });

    test('should retrieve audit log history for tutor assignments within institution', async () => {
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      await auditService.logAdminAction({
        actorUserId: instAdminUser._id,
        targetUserId: tutor._id,
        action: 'TUTOR_ASSIGNED',
        metadata: { institutionId }
      });

      const res = await institutionService.getTutorAssignmentHistory({
        actor: instAdminUser,
        tutorId: tutor._id
      });
      expect(res.data.history.length).toBe(1);
      expect(res.data.history[0].action).toBe('TUTOR_ASSIGNED');
    });
  });

  // =========================================================================
  // 10. getTutorMonitoringStats & Cascade Helpers
  // =========================================================================
  describe('getTutorMonitoringStats & Cascade Helpers', () => {
    test('should compute workload statistics and flag overloaded vs inactive tutors', async () => {
      const inactiveTutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active', name: 'Inactive Tutor' }));
      const busyTutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active', name: 'Busy Tutor' }));

      // Create 5 assignments for busy tutor
      for (let i = 0; i < 5; i++) {
        await TutorAssignment.create({
          institutionId,
          tutorId: busyTutor._id,
          courseId: new mongoose.Types.ObjectId(),
          assignmentType: 'course',
          status: 'active',
          assignedBy: instAdminUser._id
        });
      }

      const res = await institutionService.getTutorMonitoringStats({ actor: instAdminUser });
      expect(res.data.totalActiveTutors).toBe(2);
      expect(res.data.overloadedCount).toBe(1);
      expect(res.data.inactiveCount).toBe(1);

      const busyStats = res.data.tutors.find((t) => t.tutorId.toString() === busyTutor._id.toString());
      expect(busyStats.isOverloaded).toBe(true);
      expect(busyStats.activeAssignments).toBe(5);

      const inactiveStats = res.data.tutors.find((t) => t.tutorId.toString() === inactiveTutor._id.toString());
      expect(inactiveStats.isInactive).toBe(true);
      expect(inactiveStats.activeAssignments).toBe(0);
    });

    test('suspendTutorCascade should deactivate active tutor assignments and log audits', async () => {
      const tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      const assignment = await TutorAssignment.create({
        institutionId,
        tutorId: tutor._id,
        courseId: new mongoose.Types.ObjectId(),
        assignmentType: 'course',
        status: 'active',
        assignedBy: instAdminUser._id
      });

      await institutionService.suspendTutorCascade({
        tutorId: tutor._id,
        institutionId,
        actorUserId: instAdminUser._id
      });

      const inDb = await TutorAssignment.findById(assignment._id);
      expect(inDb.status).toBe('removed');
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'TUTOR_REMOVED',
          targetUserId: tutor._id,
          metadata: expect.objectContaining({ reason: 'TUTOR_SUSPENDED' })
        })
      );
    });

    test('deactivateAssignmentsForCourse should mark active assignments as removed', async () => {
      const courseId = new mongoose.Types.ObjectId();
      const assignment = await TutorAssignment.create({
        institutionId,
        tutorId: new mongoose.Types.ObjectId(),
        courseId,
        assignmentType: 'course',
        status: 'active',
        assignedBy: instAdminUser._id
      });

      await institutionService.deactivateAssignmentsForCourse(courseId);

      const inDb = await TutorAssignment.findById(assignment._id);
      expect(inDb.status).toBe('removed');
      expect(inDb.metadata?.reason).toBe('COURSE_DELETED');
    });

    test('deactivateAssignmentsForBatch should mark active assignments as removed', async () => {
      const batchId = new mongoose.Types.ObjectId();
      const assignment = await TutorAssignment.create({
        institutionId,
        tutorId: new mongoose.Types.ObjectId(),
        batchId,
        assignmentType: 'batch',
        status: 'active',
        assignedBy: instAdminUser._id
      });

      await institutionService.deactivateAssignmentsForBatch(batchId);

      const inDb = await TutorAssignment.findById(assignment._id);
      expect(inDb.status).toBe('removed');
      expect(inDb.metadata?.reason).toBe('BATCH_DELETED');
    });
  });

  // =========================================================================
  // 11. Attendance Tracking & Exports
  // =========================================================================
  describe('Attendance Tracking & Exports', () => {
    let tutor;
    let learner;
    let batch;
    let course;
    let liveSession;

    beforeEach(async () => {
      tutor = await User.create(buildUser({ institutionId, role: 'tutor', status: 'active' }));
      learner = await User.create(buildUser({ institutionId, role: 'learner', status: 'active', email: 'attendee@inst.com' }));
      batch = await Batch.create({
        institutionId,
        name: 'Attendance Batch',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 30),
        students: [{ userId: learner._id }]
      });
      course = await Course.create({
        title: 'Attendance Course',
        slug: `att-course-${Date.now()}`,
        description: 'desc',
        category: 'Development',
        level: 'Beginner',
        authorId: tutor._id,
        institutionId
      });
      liveSession = await LiveSession.create({
        courseId: course._id,
        tutorId: tutor._id,
        batchId: batch._id,
        title: 'Morning Class',
        startTime: new Date(),
        endTime: new Date(Date.now() + 3600000),
        status: 'scheduled',
        timezone: 'UTC',
        durationMinutes: 60
      });
    });

    test('getAttendanceRoster should return roster of students and existing attendance', async () => {
      await Attendance.create({
        sessionId: liveSession._id,
        learnerId: learner._id,
        institutionId,
        batchId: batch._id,
        attendanceStatus: 'present'
      });

      const res = await institutionService.getAttendanceRoster({
        actor: instAdminUser,
        sessionId: liveSession._id
      });

      expect(res.data.students.length).toBe(1);
      expect(res.data.students[0].attendance.attendanceStatus).toBe('present');
    });

    test('getAttendanceRoster should throw 403 SESSION_NOT_IN_INSTITUTION for session in other institution', async () => {
      const otherInst = await createTestInstitution();
      const otherBatch = await Batch.create({
        institutionId: otherInst._id,
        name: 'Other Inst Batch',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000)
      });
      const otherSession = await LiveSession.create({
        courseId: course._id,
        tutorId: tutor._id,
        batchId: otherBatch._id,
        title: 'Other Session',
        startTime: new Date(),
        endTime: new Date(Date.now() + 3600000),
        status: 'scheduled',
        timezone: 'UTC',
        durationMinutes: 60
      });

      await expect(
        institutionService.getAttendanceRoster({
          actor: instAdminUser,
          sessionId: otherSession._id
        })
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'SESSION_NOT_IN_INSTITUTION'
      });
    });

    test('markAttendance should upsert records for valid batch students and track failed ones', async () => {
      const outsiderId = new mongoose.Types.ObjectId();
      const res = await institutionService.markAttendance({
        actor: instAdminUser,
        sessionId: liveSession._id,
        records: [
          { studentId: learner._id, status: 'present', note: 'On time' },
          { studentId: outsiderId, status: 'absent' }
        ]
      });

      expect(res.data.updated.length).toBe(1);
      expect(res.data.failed.length).toBe(1);
      expect(res.data.failed[0].reason).toBe('Student is not in this batch');

      const inDb = await Attendance.findOne({ sessionId: liveSession._id, learnerId: learner._id });
      expect(inDb.attendanceStatus).toBe('present');
      expect(inDb.note).toBe('On time');
      expect(inDb.joinedAt).toBeTruthy();
    });

    test('exportAttendanceForSession should generate valid CSV buffer', async () => {
      await Attendance.create({
        sessionId: liveSession._id,
        learnerId: learner._id,
        institutionId,
        batchId: batch._id,
        attendanceStatus: 'present',
        note: 'Good engagement'
      });

      const buffer = await institutionService.exportAttendanceForSession({
        actor: instAdminUser,
        sessionId: liveSession._id
      });

      expect(Buffer.isBuffer(buffer)).toBe(true);
      const csvStr = buffer.toString('utf8');
      expect(csvStr).toContain('attendee@inst.com');
      expect(csvStr).toContain('present');
    });

    test('getStudentAttendance & exportAttendanceForStudent should retrieve records and generate CSV', async () => {
      await Attendance.create({
        sessionId: liveSession._id,
        learnerId: learner._id,
        institutionId,
        batchId: batch._id,
        attendanceStatus: 'late',
        note: 'Joined 10m late'
      });

      const getRes = await institutionService.getStudentAttendance({
        actor: instAdminUser,
        studentId: learner._id
      });
      expect(getRes.data.attendance.length).toBe(1);
      expect(getRes.data.attendance[0].attendanceStatus).toBe('late');

      const csvBuffer = await institutionService.exportAttendanceForStudent({
        actor: instAdminUser,
        studentId: learner._id
      });
      expect(Buffer.isBuffer(csvBuffer)).toBe(true);
      expect(csvBuffer.toString('utf8')).toContain('late');
    });

    test('getStudentAttendance should throw 404 STUDENT_NOT_FOUND if student belongs to another institution', async () => {
      const extStudent = await User.create(buildUser({ institutionId: new mongoose.Types.ObjectId(), role: 'learner' }));
      await expect(
        institutionService.getStudentAttendance({ actor: instAdminUser, studentId: extStudent._id })
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'STUDENT_NOT_FOUND'
      });
    });

    test('getBatchAttendanceHistory should compute attendance status tallies for each session in batch', async () => {
      await Attendance.create({
        sessionId: liveSession._id,
        learnerId: learner._id,
        institutionId,
        batchId: batch._id,
        attendanceStatus: 'present'
      });

      const res = await institutionService.getBatchAttendanceHistory({
        actor: instAdminUser,
        batchId: batch._id
      });

      expect(res.data.sessions.length).toBe(1);
      expect(res.data.sessions[0].attendanceSummary.present).toBe(1);
      expect(res.data.sessions[0].attendanceSummary.absent).toBe(0);
    });
  });

  // =========================================================================
  // 12. getSettings & updateSettings
  // =========================================================================
  describe('getSettings & updateSettings', () => {
    test('getSettings should create default settings if none exist', async () => {
      const res = await institutionService.getSettings({ actor: instAdminUser });
      expect(res.data.allowPublicCourses).toBe(true);
      expect(res.data.institutionId.toString()).toBe(institutionId.toString());
    });

    test('updateSettings should update allowPublicCourses and set updatedBy', async () => {
      const res = await institutionService.updateSettings({
        actor: instAdminUser,
        payload: { allowPublicCourses: false }
      });

      expect(res.data.allowPublicCourses).toBe(false);
      expect(res.data.updatedBy.toString()).toBe(instAdminUser._id.toString());

      const reCheck = await institutionService.getSettings({ actor: instAdminUser });
      expect(reCheck.data.allowPublicCourses).toBe(false);
    });

    test('getSettings & updateSettings should throw 400 NO_INSTITUTION_ASSOCIATION if user lacks institutionId', async () => {
      const nonInstUser = await User.create(buildUser({ institutionId: null }));
      await expect(
        institutionService.getSettings({ actor: nonInstUser })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'NO_INSTITUTION_ASSOCIATION'
      });

      await expect(
        institutionService.updateSettings({ actor: nonInstUser, payload: { allowPublicCourses: false } })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'NO_INSTITUTION_ASSOCIATION'
      });
    });
  });
});
