const mongoose = require('mongoose');
const moduleService = require('../../../src/services/module.service');
const Course = require('../../../src/models/course.model');
const Module = require('../../../src/models/module.model');
const Lesson = require('../../../src/models/lesson.model');
const Enrollment = require('../../../src/models/enrollment.model');
const User = require('../../../src/models/user.model');
const { ApiError } = require('../../../src/utils/errors');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { buildUser } = require('../../fixtures/user.fixture');
const { buildCourse } = require('../../fixtures/course.fixture');
const { buildModule } = require('../../fixtures/module.fixture');
const { buildLesson } = require('../../fixtures/lesson.fixture');
const { buildEnrollment } = require('../../fixtures/enrollment.fixture');

// Mock Audit Service
jest.mock('../../../src/services/audit.service', () => ({
  logCourseAction: jest.fn().mockResolvedValue(true)
}));

// Mock Notification Service
jest.mock('../../../src/services/notification.service', () => ({
  createNotification: jest.fn().mockResolvedValue(true)
}));

const auditService = require('../../../src/services/audit.service');
const notificationService = require('../../../src/services/notification.service');

describe('Module Service Comprehensive Unit Tests', () => {
  let authorTutor;
  let otherTutor;
  let adminUser;
  let superAdminUser;
  let learnerUser;
  let draftCourse;
  let publishedCourse;

  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  beforeEach(async () => {
    await clearDB();
    jest.clearAllMocks();

    authorTutor = await User.create(buildUser({ role: 'tutor' }));
    otherTutor = await User.create(buildUser({ role: 'tutor' }));
    adminUser = await User.create(buildUser({ role: 'admin' }));
    superAdminUser = await User.create(buildUser({ role: 'super_admin' }));
    learnerUser = await User.create(buildUser({ role: 'learner' }));

    draftCourse = await Course.create(buildCourse(authorTutor._id, {
      title: 'Draft Web Dev Course',
      status: 'draft',
      totalModules: 0,
      totalLessons: 0
    }));

    publishedCourse = await Course.create(buildCourse(authorTutor._id, {
      title: 'Published Cloud Course',
      status: 'published',
      totalModules: 0,
      totalLessons: 0
    }));
  });

  // =========================================================================
  // 1. CREATE MODULE
  // =========================================================================
  describe('createModule', () => {
    test('should successfully create first module in a draft course with order 1 and isPublished false', async () => {
      const payload = {
        title: 'Introduction to HTML',
        description: 'Basics of HTML5 tags and layout'
      };

      const result = await moduleService.createModule({
        courseId: draftCourse._id,
        payload,
        user: authorTutor
      });

      expect(result.message).toBe('Module created successfully');
      expect(result.data).toBeDefined();
      expect(result.data.title).toBe(payload.title);
      expect(result.data.description).toBe(payload.description);
      expect(result.data.order).toBe(1);
      expect(result.data.isPublished).toBe(false); // Inherits false from draft course

      // Verify MongoDB persistence
      const savedModule = await Module.findById(result.data._id);
      expect(savedModule).toBeTruthy();
      expect(savedModule.courseId.toString()).toBe(draftCourse._id.toString());
      expect(savedModule.order).toBe(1);

      // Verify Course statistics updated
      const updatedCourse = await Course.findById(draftCourse._id);
      expect(updatedCourse.totalModules).toBe(1);

      // Verify Audit action logged
      expect(auditService.logCourseAction).toHaveBeenCalledWith(expect.objectContaining({
        courseId: draftCourse._id,
        userId: authorTutor._id,
        action: 'curriculum_update',
        metadata: { context: 'module_create' }
      }));

      // No notifications sent for draft course
      expect(notificationService.createNotification).not.toHaveBeenCalled();
    });

    test('should calculate next incremental order when previous modules exist', async () => {
      await Module.create(buildModule(draftCourse._id, { order: 1 }));
      await Module.create(buildModule(draftCourse._id, { order: 2 }));

      const result = await moduleService.createModule({
        courseId: draftCourse._id,
        payload: { title: 'Advanced CSS' },
        user: authorTutor
      });

      expect(result.data.order).toBe(3);
    });

    test('should set isPublished: true and notify enrolled learners when adding module to a published course', async () => {
      const enrolledStudent1 = await User.create(buildUser({ role: 'learner' }));
      const enrolledStudent2 = await User.create(buildUser({ role: 'learner' }));

      await Enrollment.create(buildEnrollment(enrolledStudent1._id, publishedCourse._id, { status: 'active' }));
      await Enrollment.create(buildEnrollment(enrolledStudent2._id, publishedCourse._id, { status: 'active' }));
      // Inactive enrollment should not receive notification
      await Enrollment.create(buildEnrollment(learnerUser._id, publishedCourse._id, { status: 'cancelled' }));

      const payload = { title: 'Serverless Functions' };

      const result = await moduleService.createModule({
        courseId: publishedCourse._id,
        payload,
        user: authorTutor
      });

      expect(result.data.isPublished).toBe(true); // Inherits true from published course

      // Verify notification sent to both active learners
      expect(notificationService.createNotification).toHaveBeenCalledTimes(2);
      expect(notificationService.createNotification).toHaveBeenCalledWith(expect.objectContaining({
        userId: enrolledStudent1._id,
        title: 'New Module Added',
        message: expect.stringContaining(payload.title)
      }));
      expect(notificationService.createNotification).toHaveBeenCalledWith(expect.objectContaining({
        userId: enrolledStudent2._id,
        title: 'New Module Added'
      }));
    });

    test('should allow platform admin and super_admin to create module on any course', async () => {
      const adminResult = await moduleService.createModule({
        courseId: draftCourse._id,
        payload: { title: 'Admin Created Module' },
        user: adminUser
      });
      expect(adminResult.data.title).toBe('Admin Created Module');

      const superAdminResult = await moduleService.createModule({
        courseId: draftCourse._id,
        payload: { title: 'Super Admin Created Module' },
        user: superAdminUser
      });
      expect(superAdminResult.data.title).toBe('Super Admin Created Module');
    });

    test('should default description to empty string if omitted in payload', async () => {
      const result = await moduleService.createModule({
        courseId: draftCourse._id,
        payload: { title: 'Minimal Module' },
        user: authorTutor
      });

      expect(result.data.description).toBe('');
    });

    test('should throw 404 COURSE_NOT_FOUND if course does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();

      await expect(moduleService.createModule({
        courseId: nonExistentId,
        payload: { title: 'Orphan Module' },
        user: authorTutor
      })).rejects.toThrow(ApiError);

      try {
        await moduleService.createModule({
          courseId: nonExistentId,
          payload: { title: 'Orphan Module' },
          user: authorTutor
        });
      } catch (err) {
        expect(err.statusCode).toBe(404);
        expect(err.code).toBe('COURSE_NOT_FOUND');
      }
    });

    test('should throw 404 COURSE_NOT_FOUND if course is soft-deleted', async () => {
      const deletedCourse = await Course.create(buildCourse(authorTutor._id, {
        deletedAt: new Date()
      }));

      await expect(moduleService.createModule({
        courseId: deletedCourse._id,
        payload: { title: 'Module in Deleted Course' },
        user: authorTutor
      })).rejects.toThrow('Course not found');
    });

    test('should throw 403 COURSE_ACCESS_DENIED when another tutor attempts to create a module (IDOR protection)', async () => {
      await expect(moduleService.createModule({
        courseId: draftCourse._id,
        payload: { title: 'Unauthorized Module' },
        user: otherTutor
      })).rejects.toThrow(ApiError);

      try {
        await moduleService.createModule({
          courseId: draftCourse._id,
          payload: { title: 'Unauthorized Module' },
          user: otherTutor
        });
      } catch (err) {
        expect(err.statusCode).toBe(403);
        expect(err.code).toBe('COURSE_ACCESS_DENIED');
      }
    });

    test('should throw 403 COURSE_ACCESS_DENIED when a learner attempts to create a module', async () => {
      await expect(moduleService.createModule({
        courseId: draftCourse._id,
        payload: { title: 'Learner Module' },
        user: learnerUser
      })).rejects.toThrow('You cannot edit this course');
    });

    test('should not fail module creation if notification service throws an error', async () => {
      notificationService.createNotification.mockRejectedValueOnce(new Error('Notification gateway down'));

      await Enrollment.create(buildEnrollment(learnerUser._id, publishedCourse._id, { status: 'active' }));

      const result = await moduleService.createModule({
        courseId: publishedCourse._id,
        payload: { title: 'Resilient Module' },
        user: authorTutor
      });

      expect(result.data.title).toBe('Resilient Module');
      const saved = await Module.findById(result.data._id);
      expect(saved).toBeTruthy();
    });
  });

  // =========================================================================
  // 2. UPDATE MODULE
  // =========================================================================
  describe('updateModule', () => {
    let testModule;

    beforeEach(async () => {
      testModule = await Module.create(buildModule(draftCourse._id, {
        title: 'Original Title',
        description: 'Original Description',
        isPublished: false,
        order: 1
      }));
    });

    test('should successfully update title and description', async () => {
      const result = await moduleService.updateModule({
        moduleId: testModule._id,
        payload: {
          title: 'Updated Module Title',
          description: 'Updated Module Description'
        },
        user: authorTutor
      });

      expect(result.message).toBe('Module updated successfully');
      expect(result.data.title).toBe('Updated Module Title');
      expect(result.data.description).toBe('Updated Module Description');

      // Verify MongoDB persistence
      const updated = await Module.findById(testModule._id);
      expect(updated.title).toBe('Updated Module Title');
      expect(updated.description).toBe('Updated Module Description');

      // Audit logged
      expect(auditService.logCourseAction).toHaveBeenCalledWith(expect.objectContaining({
        courseId: draftCourse._id,
        userId: authorTutor._id,
        action: 'curriculum_update',
        metadata: expect.objectContaining({ context: 'module_update', moduleId: testModule._id })
      }));
    });

    test('should ignore disallowed fields to prevent mass assignment (e.g. courseId, order, createdAt)', async () => {
      const maliciousCourseId = new mongoose.Types.ObjectId();

      await moduleService.updateModule({
        moduleId: testModule._id,
        payload: {
          title: 'Safe Update',
          courseId: maliciousCourseId,
          order: 99,
          createdAt: new Date(2000, 1, 1)
        },
        user: authorTutor
      });

      const updated = await Module.findById(testModule._id);
      expect(updated.title).toBe('Safe Update');
      expect(updated.courseId.toString()).toBe(draftCourse._id.toString());
      expect(updated.order).toBe(1); // Unchanged
    });

    test('should trigger notification to enrolled learners when module is published in a published course (wasPublishedNow)', async () => {
      const pubModule = await Module.create(buildModule(publishedCourse._id, {
        title: 'Unpublished Module in Pub Course',
        isPublished: false
      }));

      const enrolledStudent = await User.create(buildUser({ role: 'learner' }));
      await Enrollment.create(buildEnrollment(enrolledStudent._id, publishedCourse._id, { status: 'active' }));

      await moduleService.updateModule({
        moduleId: pubModule._id,
        payload: { isPublished: true },
        user: authorTutor
      });

      const updated = await Module.findById(pubModule._id);
      expect(updated.isPublished).toBe(true);

      // Notification triggered
      expect(notificationService.createNotification).toHaveBeenCalledWith(expect.objectContaining({
        userId: enrolledStudent._id,
        title: 'New Module Added',
        message: expect.stringContaining(pubModule.title)
      }));
    });

    test('should NOT trigger notification if module was already published', async () => {
      const alreadyPubModule = await Module.create(buildModule(publishedCourse._id, {
        title: 'Already Published Module',
        isPublished: true
      }));

      await Enrollment.create(buildEnrollment(learnerUser._id, publishedCourse._id, { status: 'active' }));

      await moduleService.updateModule({
        moduleId: alreadyPubModule._id,
        payload: { title: 'Renamed Already Published Module' },
        user: authorTutor
      });

      expect(notificationService.createNotification).not.toHaveBeenCalled();
    });

    test('should NOT trigger notification when publishing module in a draft course', async () => {
      await Enrollment.create(buildEnrollment(learnerUser._id, draftCourse._id, { status: 'active' }));

      await moduleService.updateModule({
        moduleId: testModule._id,
        payload: { isPublished: true },
        user: authorTutor
      });

      expect(notificationService.createNotification).not.toHaveBeenCalled();
    });

    test('should allow platform admin to update any module', async () => {
      const result = await moduleService.updateModule({
        moduleId: testModule._id,
        payload: { title: 'Admin Updated Title' },
        user: adminUser
      });

      expect(result.data.title).toBe('Admin Updated Title');
    });

    test('should throw 404 MODULE_NOT_FOUND if module does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();

      await expect(moduleService.updateModule({
        moduleId: nonExistentId,
        payload: { title: 'Test' },
        user: authorTutor
      })).rejects.toThrow(ApiError);

      try {
        await moduleService.updateModule({
          moduleId: nonExistentId,
          payload: { title: 'Test' },
          user: authorTutor
        });
      } catch (err) {
        expect(err.statusCode).toBe(404);
        expect(err.code).toBe('MODULE_NOT_FOUND');
      }
    });

    test('should throw 404 MODULE_NOT_FOUND if module is soft-deleted', async () => {
      const deletedModule = await Module.create(buildModule(draftCourse._id, {
        deletedAt: new Date()
      }));

      await expect(moduleService.updateModule({
        moduleId: deletedModule._id,
        payload: { title: 'Test' },
        user: authorTutor
      })).rejects.toThrow('Module not found');
    });

    test('should throw 404 COURSE_NOT_FOUND if parent course is missing or soft-deleted', async () => {
      await Course.findByIdAndUpdate(draftCourse._id, { deletedAt: new Date() });

      await expect(moduleService.updateModule({
        moduleId: testModule._id,
        payload: { title: 'Test' },
        user: authorTutor
      })).rejects.toThrow('Course not found');
    });

    test('should throw 403 MODULE_ACCESS_DENIED when another tutor attempts to update module (IDOR protection)', async () => {
      await expect(moduleService.updateModule({
        moduleId: testModule._id,
        payload: { title: 'Malicious Update' },
        user: otherTutor
      })).rejects.toThrow(ApiError);

      try {
        await moduleService.updateModule({
          moduleId: testModule._id,
          payload: { title: 'Malicious Update' },
          user: otherTutor
        });
      } catch (err) {
        expect(err.statusCode).toBe(403);
        expect(err.code).toBe('MODULE_ACCESS_DENIED');
      }
    });

    test('should throw 403 MODULE_ACCESS_DENIED when learner attempts to update module', async () => {
      await expect(moduleService.updateModule({
        moduleId: testModule._id,
        payload: { title: 'Learner Edit' },
        user: learnerUser
      })).rejects.toThrow('You cannot edit this module');
    });
  });

  // =========================================================================
  // 3. DELETE MODULE
  // =========================================================================
  describe('deleteModule', () => {
    let moduleToDelete;
    let otherModule;
    let lessonInModule1;
    let lessonInModule2;

    beforeEach(async () => {
      moduleToDelete = await Module.create(buildModule(draftCourse._id, {
        title: 'Module To Delete',
        order: 1
      }));

      otherModule = await Module.create(buildModule(draftCourse._id, {
        title: 'Surviving Module',
        order: 2
      }));

      lessonInModule1 = await Lesson.create(buildLesson(draftCourse._id, moduleToDelete._id, {
        title: 'Lesson to be cascade deleted',
        duration: 30
      }));

      lessonInModule2 = await Lesson.create(buildLesson(draftCourse._id, otherModule._id, {
        title: 'Lesson to survive',
        duration: 45
      }));

      // Initialize course counts
      await Course.findByIdAndUpdate(draftCourse._id, {
        totalModules: 2,
        totalLessons: 2,
        durationInMinutes: 75
      });
    });

    test('should soft-delete module and cascade soft-delete all lessons within the module', async () => {
      const result = await moduleService.deleteModule({
        moduleId: moduleToDelete._id,
        user: authorTutor
      });

      expect(result.message).toBe('Module deleted successfully');

      // 1. Verify module is soft deleted
      const deletedMod = await Module.findById(moduleToDelete._id);
      expect(deletedMod.deletedAt).toBeInstanceOf(Date);

      // 2. Verify other module is unaffected
      const survivingMod = await Module.findById(otherModule._id);
      expect(survivingMod.deletedAt).toBeNull();

      // 3. Verify cascade soft deletion of lessons in this module
      const deletedLes = await Lesson.findById(lessonInModule1._id);
      expect(deletedLes.deletedAt).toBeInstanceOf(Date);

      // 4. Verify lessons in other module are unaffected
      const survivingLes = await Lesson.findById(lessonInModule2._id);
      expect(survivingLes.deletedAt).toBeNull();

      // 5. Verify course statistics recalculated and totalModules decremented
      const updatedCourse = await Course.findById(draftCourse._id);
      expect(updatedCourse.totalModules).toBe(1);
      expect(updatedCourse.totalLessons).toBe(1);

      // 6. Verify audit action logged
      expect(auditService.logCourseAction).toHaveBeenCalledWith(expect.objectContaining({
        courseId: draftCourse._id,
        userId: authorTutor._id,
        action: 'curriculum_update',
        metadata: expect.objectContaining({ context: 'module_delete', moduleId: moduleToDelete._id })
      }));
    });

    test('should allow platform admin and super admin to delete module', async () => {
      const result = await moduleService.deleteModule({
        moduleId: moduleToDelete._id,
        user: adminUser
      });

      expect(result.message).toBe('Module deleted successfully');
      const deletedMod = await Module.findById(moduleToDelete._id);
      expect(deletedMod.deletedAt).toBeInstanceOf(Date);
    });

    test('should throw 404 MODULE_NOT_FOUND if module does not exist or is already deleted', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();

      await expect(moduleService.deleteModule({
        moduleId: nonExistentId,
        user: authorTutor
      })).rejects.toThrow(ApiError);

      try {
        await moduleService.deleteModule({
          moduleId: nonExistentId,
          user: authorTutor
        });
      } catch (err) {
        expect(err.statusCode).toBe(404);
        expect(err.code).toBe('MODULE_NOT_FOUND');
      }

      // Repeated delete of already deleted module
      await moduleService.deleteModule({ moduleId: moduleToDelete._id, user: authorTutor });
      await expect(moduleService.deleteModule({
        moduleId: moduleToDelete._id,
        user: authorTutor
      })).rejects.toThrow('Module not found');
    });

    test('should throw 500 INVALID_MODULE_DATA if module has missing courseId', async () => {
      // Create a corrupted module without courseId bypass validation
      const corruptedModule = await Module.collection.insertOne({
        title: 'Corrupted Module',
        order: 1,
        deletedAt: null
      });

      await expect(moduleService.deleteModule({
        moduleId: corruptedModule.insertedId,
        user: authorTutor
      })).rejects.toThrow(ApiError);

      try {
        await moduleService.deleteModule({
          moduleId: corruptedModule.insertedId,
          user: authorTutor
        });
      } catch (err) {
        expect(err.statusCode).toBe(500);
        expect(err.code).toBe('INVALID_MODULE_DATA');
      }
    });

    test('should throw 404 COURSE_NOT_FOUND if parent course is missing or soft-deleted', async () => {
      await Course.findByIdAndUpdate(draftCourse._id, { deletedAt: new Date() });

      await expect(moduleService.deleteModule({
        moduleId: moduleToDelete._id,
        user: authorTutor
      })).rejects.toThrow('Course not found');
    });

    test('should throw 403 MODULE_DELETE_DENIED when another tutor attempts deletion (IDOR protection)', async () => {
      await expect(moduleService.deleteModule({
        moduleId: moduleToDelete._id,
        user: otherTutor
      })).rejects.toThrow(ApiError);

      try {
        await moduleService.deleteModule({
          moduleId: moduleToDelete._id,
          user: otherTutor
        });
      } catch (err) {
        expect(err.statusCode).toBe(403);
        expect(err.code).toBe('MODULE_DELETE_DENIED');
      }
    });

    test('should throw 403 MODULE_DELETE_DENIED when learner attempts deletion', async () => {
      await expect(moduleService.deleteModule({
        moduleId: moduleToDelete._id,
        user: learnerUser
      })).rejects.toThrow('You cannot delete this module');
    });
  });

  // =========================================================================
  // 4. REORDER MODULES
  // =========================================================================
  describe('reorderModules', () => {
    let mod1;
    let mod2;
    let mod3;

    beforeEach(async () => {
      mod1 = await Module.create(buildModule(draftCourse._id, { title: 'Mod 1', order: 1 }));
      mod2 = await Module.create(buildModule(draftCourse._id, { title: 'Mod 2', order: 2 }));
      mod3 = await Module.create(buildModule(draftCourse._id, { title: 'Mod 3', order: 3 }));
    });

    test('should successfully reorder modules sequentially with new 1-based order', async () => {
      // Reorder from [1, 2, 3] to [3, 1, 2]
      const newOrder = [mod3._id, mod1._id, mod2._id];

      const result = await moduleService.reorderModules({
        courseId: draftCourse._id,
        orderedModuleIds: newOrder,
        user: authorTutor
      });

      expect(result.message).toBe('Modules reordered successfully');
      expect(result.data).toBe(true);

      // Verify MongoDB persistence
      const updatedMod3 = await Module.findById(mod3._id);
      const updatedMod1 = await Module.findById(mod1._id);
      const updatedMod2 = await Module.findById(mod2._id);

      expect(updatedMod3.order).toBe(1);
      expect(updatedMod1.order).toBe(2);
      expect(updatedMod2.order).toBe(3);

      // Verify Audit action logged
      expect(auditService.logCourseAction).toHaveBeenCalledWith(expect.objectContaining({
        courseId: draftCourse._id,
        userId: authorTutor._id,
        action: 'curriculum_update',
        metadata: { context: 'module_reorder' }
      }));
    });

    test('should allow platform admin to reorder modules', async () => {
      const result = await moduleService.reorderModules({
        courseId: draftCourse._id,
        orderedModuleIds: [mod2._id, mod1._id, mod3._id],
        user: adminUser
      });

      expect(result.data).toBe(true);
      const updatedMod2 = await Module.findById(mod2._id);
      expect(updatedMod2.order).toBe(1);
    });

    test('should throw 404 COURSE_NOT_FOUND if course is not found or soft-deleted', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();

      await expect(moduleService.reorderModules({
        courseId: nonExistentId,
        orderedModuleIds: [mod1._id, mod2._id, mod3._id],
        user: authorTutor
      })).rejects.toThrow('Course not found');
    });

    test('should throw 403 MODULE_REORDER_DENIED when another tutor attempts reorder (IDOR protection)', async () => {
      await expect(moduleService.reorderModules({
        courseId: draftCourse._id,
        orderedModuleIds: [mod1._id, mod2._id, mod3._id],
        user: otherTutor
      })).rejects.toThrow(ApiError);

      try {
        await moduleService.reorderModules({
          courseId: draftCourse._id,
          orderedModuleIds: [mod1._id, mod2._id, mod3._id],
          user: otherTutor
        });
      } catch (err) {
        expect(err.statusCode).toBe(403);
        expect(err.code).toBe('MODULE_REORDER_DENIED');
      }
    });

    test('should throw 403 MODULE_REORDER_DENIED when learner attempts reorder', async () => {
      await expect(moduleService.reorderModules({
        courseId: draftCourse._id,
        orderedModuleIds: [mod1._id, mod2._id, mod3._id],
        user: learnerUser
      })).rejects.toThrow('You cannot reorder modules in this course');
    });

    test('should throw 400 INVALID_MODULE_ORDER if orderedModuleIds is not an array', async () => {
      await expect(moduleService.reorderModules({
        courseId: draftCourse._id,
        orderedModuleIds: 'not_an_array',
        user: authorTutor
      })).rejects.toThrow(ApiError);

      try {
        await moduleService.reorderModules({
          courseId: draftCourse._id,
          orderedModuleIds: 'not_an_array',
          user: authorTutor
        });
      } catch (err) {
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('INVALID_MODULE_ORDER');
      }
    });

    test('should throw 400 INVALID_MODULE_ORDER if module count does not match existing modules', async () => {
      // Only passing 2 modules instead of 3
      await expect(moduleService.reorderModules({
        courseId: draftCourse._id,
        orderedModuleIds: [mod1._id, mod2._id],
        user: authorTutor
      })).rejects.toThrow(ApiError);

      try {
        await moduleService.reorderModules({
          courseId: draftCourse._id,
          orderedModuleIds: [mod1._id, mod2._id],
          user: authorTutor
        });
      } catch (err) {
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('INVALID_MODULE_ORDER');
        expect(err.message).toBe('Module count mismatch');
      }
    });

    test('should throw 400 INVALID_MODULE_ID if array contains a module ID from another course', async () => {
      const otherCourse = await Course.create(buildCourse(authorTutor._id));
      const foreignModule = await Module.create(buildModule(otherCourse._id, { title: 'Foreign Mod' }));

      await expect(moduleService.reorderModules({
        courseId: draftCourse._id,
        orderedModuleIds: [mod1._id, mod2._id, foreignModule._id],
        user: authorTutor
      })).rejects.toThrow(ApiError);

      try {
        await moduleService.reorderModules({
          courseId: draftCourse._id,
          orderedModuleIds: [mod1._id, mod2._id, foreignModule._id],
          user: authorTutor
        });
      } catch (err) {
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('INVALID_MODULE_ID');
      }
    });
  });
});
