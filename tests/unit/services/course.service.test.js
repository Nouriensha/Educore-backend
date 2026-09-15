const mongoose = require('mongoose');
const courseService = require('../../../src/services/course.service');

const Course = require('../../../src/models/course.model');
const Module = require('../../../src/models/module.model');
const Lesson = require('../../../src/models/lesson.model');
const Enrollment = require('../../../src/models/enrollment.model');
const User = require('../../../src/models/user.model');
const Progress = require('../../../src/models/progress.model');
const Institution = require('../../../src/models/institution.model');
const InstitutionMembership = require('../../../src/models/institutionMembership.model');
const InstitutionSettings = require('../../../src/models/institutionSettings.model');
const Certificate = require('../../../src/models/certificate.model');
const CertificateTemplate = require('../../../src/models/certificateTemplate.model');
const Notification = require('../../../src/models/notification.model');
const QuizAttempt = require('../../../src/models/quizAttempt.model');

const storageService = require('../../../src/services/storage.service');
const auditService = require('../../../src/services/audit.service');
const emailService = require('../../../src/services/email.service');
const institutionService = require('../../../src/services/institution.service');
const notificationService = require('../../../src/services/notification.service');

const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { buildCourse } = require('../../fixtures/course.fixture');
const { buildModule } = require('../../fixtures/module.fixture');
const { buildLesson } = require('../../fixtures/lesson.fixture');

// Mock external services
jest.mock('../../../src/services/storage.service', () => ({
  uploadCourseThumbnail: jest.fn().mockResolvedValue('https://storage.example.com/thumb.jpg')
}));

jest.mock('../../../src/services/audit.service', () => ({
  logCourseAction: jest.fn().mockResolvedValue({}),
  getCourseLogs: jest.fn().mockResolvedValue([{ action: 'test_action' }])
}));

jest.mock('../../../src/services/email.service', () => ({
  sendMail: jest.fn().mockResolvedValue({}),
  sendCoursePublishedEmail: jest.fn().mockResolvedValue({})
}));

jest.mock('../../../src/services/institution.service', () => ({
  deactivateAssignmentsForCourse: jest.fn().mockResolvedValue({})
}));

jest.mock('../../../src/services/notification.service', () => ({
  triggerCourseReviewSubmittedAlert: jest.fn().mockResolvedValue({}),
  sendPushNotification: jest.fn().mockReturnValue(true)
}));

describe('Course Service Unit Tests (src/services/course.service.js)', () => {
  let activeTutor;
  let inactiveTutor;
  let institutionalTutor;
  let otherTutor;
  let adminUser;
  let institutionAdmin;
  let learner;
  let otherLearner;
  let institution;

  beforeAll(async () => {
    await connectDB();
    await Course.init();
    await Module.init();
    await Lesson.init();
    await Enrollment.init();
    await User.init();
    await Progress.init();
    await Institution.init();
    await InstitutionMembership.init();
    await InstitutionSettings.init();
    await Certificate.init();
    await CertificateTemplate.init();
    await Notification.init();
    await QuizAttempt.init();
  });

  afterAll(async () => {
    await closeDB();
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    institution = await Institution.create({
      name: 'Oxford University',
      domain: 'oxford.edu',
      code: 'OXF001',
      email: 'admin@oxford.edu',
      owner: new mongoose.Types.ObjectId(),
      status: 'active'
    });

    activeTutor = await User.create({
      name: 'Dr. John Doe',
      email: 'john.doe@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
      role: 'tutor',
      status: 'active',
      accountType: 'individual_tutor'
    });

    inactiveTutor = await User.create({
      name: 'Dr. Jane Pending',
      email: 'jane.pending@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
      role: 'tutor',
      status: 'pending_approval',
      accountType: 'individual_tutor'
    });

    institutionalTutor = await User.create({
      name: 'Prof. Alan Smith',
      email: 'alan.smith@oxford.edu',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
      role: 'tutor',
      status: 'active',
      accountType: 'institution_tutor',
      institutionId: institution._id
    });

    otherTutor = await User.create({
      name: 'Dr. Emily Brown',
      email: 'emily.brown@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
      role: 'tutor',
      status: 'active',
      accountType: 'individual_tutor'
    });

    adminUser = await User.create({
      name: 'Super Administrator',
      email: 'superadmin@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
      role: 'super_admin',
      status: 'active'
    });

    institutionAdmin = await User.create({
      name: 'Institution Admin',
      email: 'insadmin@oxford.edu',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
      role: 'institution_admin',
      status: 'active',
      institutionId: institution._id
    });

    learner = await User.create({
      name: 'Alice Student',
      email: 'alice@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
      role: 'learner',
      status: 'active',
      accountType: 'individual_learner'
    });

    otherLearner = await User.create({
      name: 'Bob Scholar',
      email: 'bob@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
      role: 'learner',
      status: 'active',
      accountType: 'individual_learner'
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.clearAllTimers();
    await clearDB();
  });

  // =========================================================================
  // 1. createCourse
  // =========================================================================
  describe('createCourse', () => {
    test('should successfully create a draft course for active individual tutor', async () => {
      const payload = {
        title: 'Introduction to Artificial Intelligence',
        description: 'Learn the fundamentals of modern AI.',
        category: 'Data Science',
        price: 99.99,
        isFree: false
      };

      const result = await courseService.createCourse({
        payload,
        authorId: activeTutor._id
      });

      expect(result.message).toBe('Course created successfully');
      expect(result.data.title).toBe('Introduction to Artificial Intelligence');
      expect(result.data.status).toBe('draft');
      expect(String(result.data.authorId)).toBe(String(activeTutor._id));
      expect(result.data.institutionId).toBeNull();

      const saved = await Course.findById(result.data._id);
      expect(saved).not.toBeNull();
      expect(saved.category).toBe('Data Science');
    });

    test('should successfully create course with institutionId for active institutional tutor', async () => {
      await InstitutionMembership.create({
        institutionId: institution._id,
        userId: institutionalTutor._id,
        memberType: 'tutor',
        status: 'active'
      });

      const result = await courseService.createCourse({
        payload: {
          title: 'Oxford Quantum Computing',
          description: 'Study advanced quantum mechanics and computing architectures.',
          category: 'Physics',
          price: 0,
          isFree: true
        },
        authorId: institutionalTutor._id
      });

      expect(result.data.status).toBe('draft');
      expect(String(result.data.institutionId)).toBe(String(institution._id));
    });

    test('should reject creation if tutor is not active (403 TUTOR_APPROVAL_REQUIRED)', async () => {
      await expect(
        courseService.createCourse({
          payload: { title: 'Unapproved Course' },
          authorId: inactiveTutor._id
        })
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'TUTOR_APPROVAL_REQUIRED'
      });
    });

    test('should reject creation if institutional tutor lacks active membership (403 INSTITUTION_TUTOR_APPROVAL_REQUIRED)', async () => {
      await expect(
        courseService.createCourse({
          payload: { title: 'Unauthorized Institutional Course' },
          authorId: institutionalTutor._id
        })
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'INSTITUTION_TUTOR_APPROVAL_REQUIRED'
      });
    });
  });

  // =========================================================================
  // 2. getCourses
  // =========================================================================
  describe('getCourses', () => {
    test('should return paginated courses and filter by level', async () => {
      await Course.create([
        buildCourse(activeTutor._id, { title: 'Course A', level: 'Beginner' }),
        buildCourse(activeTutor._id, { title: 'Course B', level: 'Advanced' }),
        buildCourse(activeTutor._id, { title: 'Course C', level: 'Beginner', deletedAt: new Date() })
      ]);

      const result = await courseService.getCourses({ query: { level: 'Beginner', page: 1, limit: 10 } });

      expect(result.message).toBe('Courses retrieved successfully');
      expect(result.data.courses).toHaveLength(1);
      expect(result.data.courses[0].title).toBe('Course A');
      expect(result.data.pagination.total).toBe(1);
      expect(result.data.pagination.pages).toBe(1);
    });

    test('should return default pagination when query is empty', async () => {
      await Course.create(buildCourse(activeTutor._id, { title: 'Default Course' }));

      const result = await courseService.getCourses({ query: {} });
      expect(result.data.courses.length).toBeGreaterThanOrEqual(1);
      expect(result.data.pagination.page).toBe(1);
      expect(result.data.pagination.limit).toBe(10);
    });
  });

  // =========================================================================
  // 3. getCourseById
  // =========================================================================
  describe('getCourseById', () => {
    let publishedCourse;
    let draftCourse;
    let moduleDoc;
    let lesson1;
    let lesson2;

    beforeEach(async () => {
      publishedCourse = await Course.create(buildCourse(activeTutor._id, {
        title: 'Published Node Course',
        status: 'published',
        isSequential: true
      }));

      draftCourse = await Course.create(buildCourse(activeTutor._id, {
        title: 'Draft Course',
        status: 'draft'
      }));

      moduleDoc = await Module.create(buildModule(publishedCourse._id, { title: 'Module 1', order: 1 }));
      lesson1 = await Lesson.create(buildLesson(publishedCourse._id, moduleDoc._id, {
        title: 'Lesson 1 (Preview)',
        order: 1,
        isPreview: true
      }));
      lesson2 = await Lesson.create(buildLesson(publishedCourse._id, moduleDoc._id, {
        title: 'Lesson 2 (Sequential Locked)',
        order: 2,
        isPreview: false
      }));
    });

    test('should throw 404 if course does not exist or is soft-deleted', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      await expect(
        courseService.getCourseById({ courseId: nonExistentId })
      ).rejects.toMatchObject({ statusCode: 404, message: 'Course not found' });

      publishedCourse.deletedAt = new Date();
      await publishedCourse.save();

      await expect(
        courseService.getCourseById({ courseId: publishedCourse._id })
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    test('should block unenrolled guest from viewing unpublished course (403)', async () => {
      await expect(
        courseService.getCourseById({ courseId: draftCourse._id, userId: learner._id, userRole: 'learner' })
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    test('should allow author or admin to view unpublished course', async () => {
      const authorRes = await courseService.getCourseById({
        courseId: draftCourse._id,
        userId: activeTutor._id,
        userRole: 'tutor'
      });
      expect(authorRes.data.course._id.toString()).toBe(draftCourse._id.toString());

      const adminRes = await courseService.getCourseById({
        courseId: draftCourse._id,
        userId: adminUser._id,
        userRole: 'super_admin'
      });
      expect(adminRes.data.course._id.toString()).toBe(draftCourse._id.toString());
    });

    test('should compute correct lock states for sequential course for guest vs enrolled', async () => {
      // Guest viewer
      const guestRes = await courseService.getCourseById({ courseId: publishedCourse._id });
      const guestLessons = guestRes.data.modules[0].lessons;
      expect(guestLessons[0].isPreview).toBe(true);
      expect(guestLessons[0].isLocked).toBe(false);
      expect(guestLessons[1].isPreview).toBe(false);
      expect(guestLessons[1].isLocked).toBe(true);

      // Enrolled viewer who completed lesson 1
      await Enrollment.create({
        userId: learner._id,
        courseId: publishedCourse._id,
        status: 'active',
        enrollmentType: 'paid'
      });
      await Progress.create({
        userId: learner._id,
        courseId: publishedCourse._id,
        completedLessons: [lesson1._id],
        videoProgress: [{ lessonId: lesson1._id, secondsWatched: 120 }]
      });

      const enrolledRes = await courseService.getCourseById({
        courseId: publishedCourse._id,
        userId: learner._id,
        userRole: 'learner'
      });
      expect(enrolledRes.data.isEnrolled).toBe(true);
      const enrolledLessons = enrolledRes.data.modules[0].lessons;
      expect(enrolledLessons[0].isCompleted).toBe(true);
      expect(enrolledLessons[0].secondsWatched).toBe(120);
      expect(enrolledLessons[1].isLocked).toBe(false);
    });

    test('should restrict institutional course to same institution members (403 INSTITUTION_COURSE_RESTRICTED)', async () => {
      const insCourse = await Course.create(buildCourse(institutionalTutor._id, {
        institutionId: institution._id,
        status: 'published'
      }));

      // Guest access
      await expect(
        courseService.getCourseById({ courseId: insCourse._id })
      ).rejects.toMatchObject({ statusCode: 403, code: 'INSTITUTION_COURSE_RESTRICTED' });

      // Outsider learner access
      await expect(
        courseService.getCourseById({ courseId: insCourse._id, userId: learner._id, userRole: 'learner' })
      ).rejects.toMatchObject({ statusCode: 403, code: 'INSTITUTION_COURSE_RESTRICTED' });

      // Inside institution admin access
      const insideRes = await courseService.getCourseById({
        courseId: insCourse._id,
        userId: institutionAdmin._id,
        userRole: 'institution_admin'
      });
      expect(insideRes.data.course._id.toString()).toBe(insCourse._id.toString());
    });

    test('should reject public course if user institution disabled public courses (403 PUBLIC_COURSES_DISABLED)', async () => {
      await InstitutionSettings.create({
        institutionId: institution._id,
        allowPublicCourses: false
      });

      const insStudent = await User.create({
        name: 'Ins Student',
        email: 'ins.student@oxford.edu',
        passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
        role: 'learner',
        status: 'active',
        institutionId: institution._id
      });

      await expect(
        courseService.getCourseById({
          courseId: publishedCourse._id,
          userId: insStudent._id,
          userRole: 'learner'
        })
      ).rejects.toMatchObject({ statusCode: 403, code: 'PUBLIC_COURSES_DISABLED' });
    });
  });

  // =========================================================================
  // 4. updateCourse
  // =========================================================================
  describe('updateCourse', () => {
    let draftCourse;
    let publishedCourse;

    beforeEach(async () => {
      draftCourse = await Course.create(buildCourse(activeTutor._id, {
        title: 'Old Draft Title',
        status: 'draft',
        price: 19.99
      }));

      publishedCourse = await Course.create(buildCourse(activeTutor._id, {
        title: 'Old Published Title',
        status: 'published',
        price: 29.99
      }));
    });

    test('should throw 404 if course not found', async () => {
      await expect(
        courseService.updateCourse({
          courseId: new mongoose.Types.ObjectId(),
          payload: { title: 'New Title' },
          user: activeTutor
        })
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    test('should throw 403 if user is not author and not admin', async () => {
      await expect(
        courseService.updateCourse({
          courseId: draftCourse._id,
          payload: { title: 'Hacked Title' },
          user: otherTutor
        })
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    test('should update draft course directly and ignore disallowed fields', async () => {
      const result = await courseService.updateCourse({
        courseId: draftCourse._id,
        payload: {
          title: 'Updated Draft Title',
          price: 39.99,
          enrollmentCount: 9999, // disallowed protected field
          authorId: otherTutor._id // disallowed protected field
        },
        user: activeTutor
      });

      expect(result.message).toBe('Course updated successfully');
      expect(result.data.title).toBe('Updated Draft Title');
      expect(result.data.price).toBe(39.99);
      expect(String(result.data.authorId)).toBe(String(activeTutor._id));
      expect(result.data.enrollmentCount).toBe(0);

      expect(auditService.logCourseAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'update', metadata: expect.objectContaining({ mode: 'direct_update' }) })
      );
    });

    test('should save changes as pendingChanges when updating a published course', async () => {
      const result = await courseService.updateCourse({
        courseId: publishedCourse._id,
        payload: { title: 'Pending Published Title', price: 49.99 },
        user: activeTutor
      });

      expect(result.message).toBe('Changes saved as pending update');
      expect(result.data.title).toBe('Old Published Title'); // live title untouched
      expect(result.data.pendingChanges.title).toBe('Pending Published Title');
      expect(result.data.pendingChanges.price).toBe(49.99);

      expect(auditService.logCourseAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'update', metadata: expect.objectContaining({ mode: 'pending_changes' }) })
      );
    });
  });

  // =========================================================================
  // 5. getCourseCurriculum & getCoursePreviewCurriculum
  // =========================================================================
  describe('getCourseCurriculum & getCoursePreviewCurriculum', () => {
    let course;
    let mod;
    let lesson;

    beforeEach(async () => {
      course = await Course.create(buildCourse(activeTutor._id, { status: 'published' }));
      mod = await Module.create(buildModule(course._id, { title: 'Module 1', isPublished: true }));
      lesson = await Lesson.create(buildLesson(course._id, mod._id, {
        title: 'Preview Lesson',
        isPreview: true,
        isPublished: true,
        attachments: [{ title: 'Notes', fileUrl: 'https://notes.pdf' }]
      }));
    });

    test('getCourseCurriculum should return curriculum structure with attachments and duration', async () => {
      const res = await courseService.getCourseCurriculum({
        courseId: course._id,
        userId: activeTutor._id,
        userRole: 'tutor'
      });

      expect(res.message).toBe('Course curriculum retrieved successfully');
      expect(res.data.modules).toHaveLength(1);
      const l = res.data.modules[0].lessons[0];
      expect(l.title).toBe('Preview Lesson');
      expect(l.attachments).toHaveLength(1);
      expect(l.attachments[0].url).toBe('https://notes.pdf');
    });

    test('getCourseCurriculum should throw 403 for draft course accessed by learner', async () => {
      course.status = 'draft';
      await course.save();

      await expect(
        courseService.getCourseCurriculum({
          courseId: course._id,
          userId: learner._id,
          userRole: 'learner'
        })
      ).rejects.toMatchObject({ statusCode: 403, code: 'COURSE_UNAVAILABLE' });
    });

    test('getCoursePreviewCurriculum should strip attachments and details for non-preview lessons', async () => {
      const lockedLesson = await Lesson.create(buildLesson(course._id, mod._id, {
        title: 'Locked Lesson',
        isPreview: false,
        isPublished: true,
        content: 'Secret content',
        attachments: [{ title: 'Secret Sheet', fileUrl: 'https://secret.pdf' }]
      }));

      const res = await courseService.getCoursePreviewCurriculum({ courseId: course._id });
      expect(res.message).toBe('Course preview curriculum retrieved successfully');
      const lessons = res.data.modules[0].lessons;

      const previewL = lessons.find(x => x.id === lesson._id.toString());
      expect(previewL.isPreview).toBe(true);
      expect(previewL.isLocked).toBe(false);

      const lockedL = lessons.find(x => x.id === lockedLesson._id.toString());
      expect(lockedL.isPreview).toBe(false);
      expect(lockedL.isLocked).toBe(true);
      expect(lockedL.content).toBeNull();
      expect(lockedL.attachments).toEqual([]);
    });
  });

  // =========================================================================
  // 6. checkCoursePublishReadiness
  // =========================================================================
  describe('checkCoursePublishReadiness', () => {
    let course;

    beforeEach(async () => {
      course = await Course.create(buildCourse(activeTutor._id, { status: 'draft' }));
    });

    test('should throw 400 NO_MODULES_FOUND when course has no modules', async () => {
      await expect(
        courseService.checkCoursePublishReadiness({ courseId: course._id })
      ).rejects.toMatchObject({ statusCode: 400, code: 'NO_MODULES_FOUND' });
    });

    test('should throw 400 NO_LESSONS_FOUND when course has modules but 0 lessons', async () => {
      await Module.create(buildModule(course._id));
      await expect(
        courseService.checkCoursePublishReadiness({ courseId: course._id })
      ).rejects.toMatchObject({ statusCode: 400, code: 'NO_LESSONS_FOUND' });
    });

    test('should throw 400 EMPTY_MODULE_FOUND when an empty module exists', async () => {
      const m1 = await Module.create(buildModule(course._id, { order: 1 }));
      await Module.create(buildModule(course._id, { order: 2 })); // empty module
      await Lesson.create(buildLesson(course._id, m1._id));

      await expect(
        courseService.checkCoursePublishReadiness({ courseId: course._id })
      ).rejects.toMatchObject({ statusCode: 400, code: 'EMPTY_MODULE_FOUND' });
    });

    test('should succeed when every module has at least one lesson', async () => {
      const m1 = await Module.create(buildModule(course._id, { order: 1 }));
      await Lesson.create(buildLesson(course._id, m1._id));

      const res = await courseService.checkCoursePublishReadiness({ courseId: course._id });
      expect(res.data.isReady).toBe(true);
      expect(res.data.totalModules).toBe(1);
      expect(res.data.totalLessons).toBe(1);
    });
  });

  // =========================================================================
  // 7. publishCourse, unpublishCourse & discardPendingChanges
  // =========================================================================
  describe('publishCourse, unpublishCourse & discardPendingChanges', () => {
    let course;
    let mod;
    let lesson;

    beforeEach(async () => {
      course = await Course.create(buildCourse(activeTutor._id, {
        status: 'draft',
        pendingChanges: { title: 'Approved New Title' }
      }));
      mod = await Module.create(buildModule(course._id, { isPublished: false }));
      lesson = await Lesson.create(buildLesson(course._id, mod._id, { isPublished: false }));
    });

    test('publishCourse should validate readiness, apply pending changes, publish lessons and modules', async () => {
      const res = await courseService.publishCourse({
        courseId: course._id,
        user: activeTutor,
        sendNotification: true
      });

      expect(res.message).toContain('published successfully');
      expect(res.data.status).toBe('published');
      expect(res.data.title).toBe('Approved New Title');
      expect(res.data.pendingChanges).toBeNull();

      const updatedMod = await Module.findById(mod._id);
      expect(updatedMod.isPublished).toBe(true);

      const updatedLesson = await Lesson.findById(lesson._id);
      expect(updatedLesson.isPublished).toBe(true);

      expect(auditService.logCourseAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'status_change', metadata: { status: 'published' } })
      );
    });

    test('publishCourse should validate certificate template when certificates enabled', async () => {
      course.certificateEnabled = true;
      await course.save();

      // Missing template
      await expect(
        courseService.publishCourse({ courseId: course._id, user: activeTutor })
      ).rejects.toMatchObject({ statusCode: 400, code: 'CERTIFICATE_TEMPLATE_REQUIRED' });

      // Inactive/Non-existent template
      course.certificateTemplateId = new mongoose.Types.ObjectId();
      await course.save();
      await expect(
        courseService.publishCourse({ courseId: course._id, user: activeTutor })
      ).rejects.toMatchObject({ statusCode: 400, code: 'CERTIFICATE_TEMPLATE_INVALID' });

      // Valid template scope check (individual course requires platform template)
      const template = await CertificateTemplate.create({
        name: 'Platform Template',
        scope: 'platform',
        version: 2,
        isActive: true,
        createdBy: adminUser._id,
        updatedBy: adminUser._id
      });
      course.certificateTemplateId = template._id;
      await course.save();

      const res = await courseService.publishCourse({ courseId: course._id, user: activeTutor });
      expect(res.data.certificateTemplateVersion).toBe(2);
    });

    test('publishCourse should reject certificate template scope mismatch', async () => {
      course.certificateEnabled = true;
      const insTemplate = await CertificateTemplate.create({
        name: 'Ins Template',
        scope: 'institution',
        institutionId: institution._id,
        isActive: true,
        createdBy: adminUser._id,
        updatedBy: adminUser._id
      });
      course.certificateTemplateId = insTemplate._id;
      await course.save();

      // Individual course using institution template -> reject
      await expect(
        courseService.publishCourse({ courseId: course._id, user: activeTutor })
      ).rejects.toMatchObject({ statusCode: 400, code: 'CERTIFICATE_TEMPLATE_SCOPE_INVALID' });

      // Institutional course using mismatching institution template -> reject
      await InstitutionMembership.create({
        institutionId: institution._id,
        userId: institutionalTutor._id,
        memberType: 'tutor',
        status: 'active'
      });

      const mismatchTemplate = await CertificateTemplate.create({
        name: 'Mismatch Template',
        scope: 'institution',
        institutionId: new mongoose.Types.ObjectId(),
        isActive: true,
        createdBy: adminUser._id,
        updatedBy: adminUser._id
      });

      const insCourse = await Course.create(buildCourse(institutionalTutor._id, {
        institutionId: institution._id,
        certificateEnabled: true,
        certificateTemplateId: mismatchTemplate._id
      }));
      const insMod = await Module.create(buildModule(insCourse._id));
      await Lesson.create(buildLesson(insCourse._id, insMod._id));

      await expect(
        courseService.publishCourse({ courseId: insCourse._id, user: institutionalTutor })
      ).rejects.toMatchObject({ statusCode: 400, code: 'CERTIFICATE_TEMPLATE_SCOPE_INVALID' });
    });

    test('publishCourse should throw 404 if course not found and 403 if unauthorized', async () => {
      await expect(
        courseService.publishCourse({ courseId: new mongoose.Types.ObjectId(), user: activeTutor })
      ).rejects.toMatchObject({ statusCode: 404 });

      await expect(
        courseService.publishCourse({ courseId: course._id, user: otherTutor })
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    test('unpublishCourse should transition status to unpublished and visibility to private', async () => {
      course.status = 'published';
      await course.save();

      const res = await courseService.unpublishCourse({ courseId: course._id, user: activeTutor });
      expect(res.data.status).toBe('unpublished');
      expect(res.data.visibility).toBe('private');

      // 404 and 403 checks
      await expect(
        courseService.unpublishCourse({ courseId: new mongoose.Types.ObjectId(), user: activeTutor })
      ).rejects.toMatchObject({ statusCode: 404 });

      await expect(
        courseService.unpublishCourse({ courseId: course._id, user: otherTutor })
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    test('discardPendingChanges should clear pendingChanges without modifying base fields', async () => {
      const res = await courseService.discardPendingChanges({ courseId: course._id, user: activeTutor });
      expect(res.data.pendingChanges).toBeNull();
      expect(auditService.logCourseAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'discard_changes' })
      );

      // 404 and 403 checks
      await expect(
        courseService.discardPendingChanges({ courseId: new mongoose.Types.ObjectId(), user: activeTutor })
      ).rejects.toMatchObject({ statusCode: 404 });

      await expect(
        courseService.discardPendingChanges({ courseId: course._id, user: otherTutor })
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  // =========================================================================
  // 8. getCourseCatalogue
  // =========================================================================
  describe('getCourseCatalogue', () => {
    beforeEach(async () => {
      await Course.create([
        buildCourse(activeTutor._id, {
          title: 'React Basics',
          category: 'Frontend',
          level: 'Beginner',
          price: 0,
          isFree: true,
          status: 'published',
          averageRating: 4.8,
          featured: false,
          enrollmentCount: 50
        }),
        buildCourse(activeTutor._id, {
          title: 'Advanced Microservices',
          category: 'Backend',
          level: 'Advanced',
          price: 99,
          isFree: false,
          status: 'published',
          averageRating: 4.2,
          featured: false,
          enrollmentCount: 150
        }),
        buildCourse(activeTutor._id, {
          title: 'Unpublished Go Course',
          status: 'draft'
        })
      ]);
    });

    test('should filter by free price and category', async () => {
      const res = await courseService.getCourseCatalogue({
        query: { price: 'free', category: 'Frontend' }
      });

      expect(res.data.courses).toHaveLength(1);
      expect(res.data.courses[0].title).toBe('React Basics');
    });

    test('should sort by popular (enrollmentCount)', async () => {
      const res = await courseService.getCourseCatalogue({
        query: { sort: 'popular' }
      });

      expect(res.data.courses[0].title).toBe('Advanced Microservices');
    });

    test('should sort by rating, price_low, and price_high', async () => {
      const resRating = await courseService.getCourseCatalogue({ query: { sort: 'rating' } });
      expect(resRating.data.courses[0].title).toBe('React Basics');

      const resPriceLow = await courseService.getCourseCatalogue({ query: { sort: 'price_low' } });
      expect(resPriceLow.data.courses[0].title).toBe('React Basics');

      const resPriceHigh = await courseService.getCourseCatalogue({ query: { sort: 'price_high' } });
      expect(resPriceHigh.data.courses[0].title).toBe('Advanced Microservices');
    });

    test('should filter by level, paid price, rating, and featured', async () => {
      const resLevel = await courseService.getCourseCatalogue({ query: { level: 'Advanced' } });
      expect(resLevel.data.courses).toHaveLength(1);
      expect(resLevel.data.courses[0].title).toBe('Advanced Microservices');

      const resPaid = await courseService.getCourseCatalogue({ query: { price: 'paid' } });
      expect(resPaid.data.courses).toHaveLength(1);
      expect(resPaid.data.courses[0].title).toBe('Advanced Microservices');

      const resRating = await courseService.getCourseCatalogue({ query: { rating: 4.5 } });
      expect(resRating.data.courses).toHaveLength(1);
      expect(resRating.data.courses[0].title).toBe('React Basics');

      const resFeatured = await courseService.getCourseCatalogue({ query: { featured: false } });
      expect(resFeatured.data.courses.length).toBeGreaterThanOrEqual(1);
    });

    test('should search by text match', async () => {
      const res = await courseService.getCourseCatalogue({
        query: { search: 'React' }
      });

      expect(res.data.courses).toHaveLength(1);
      expect(res.data.courses[0].title).toBe('React Basics');
    });

    test('should mark isEnrolled: true for enrolled learner', async () => {
      const course = await Course.findOne({ title: 'React Basics' });
      await Enrollment.create({
        userId: learner._id,
        courseId: course._id,
        status: 'active',
        enrollmentType: 'free'
      });

      const res = await courseService.getCourseCatalogue({
        query: {},
        userId: learner._id
      });

      const react = res.data.courses.find(c => c.title === 'React Basics');
      expect(react.isEnrolled).toBe(true);

      const micro = res.data.courses.find(c => c.title === 'Advanced Microservices');
      expect(micro.isEnrolled).toBe(false);
    });
  });

  // =========================================================================
  // 9. getMyCourses, getCourseStats & getAllCoursesAdmin
  // =========================================================================
  describe('getMyCourses, getCourseStats & getAllCoursesAdmin', () => {
    let course1;

    beforeEach(async () => {
      course1 = await Course.create(buildCourse(activeTutor._id, {
        title: 'Python for Beginners',
        status: 'published',
        enrollmentCount: 25
      }));
      await Module.create(buildModule(course1._id));
      await Lesson.create(buildLesson(course1._id, new mongoose.Types.ObjectId()));
    });

    test('getMyCourses should return courses belonging to authenticated tutor', async () => {
      const res = await courseService.getMyCourses({
        user: activeTutor,
        query: { search: 'Python' }
      });

      expect(res.data.courses).toHaveLength(1);
      expect(res.data.courses[0].title).toBe('Python for Beginners');
    });

    test('getCourseStats should return stats for author and 404 for non-author', async () => {
      const res = await courseService.getCourseStats({ courseId: course1._id, user: activeTutor });
      expect(res.data.enrollmentCount).toBe(25);
      expect(res.data.modules).toBe(1);
      expect(res.data.lessons).toBe(1);

      await expect(
        courseService.getCourseStats({ courseId: course1._id, user: otherTutor })
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    test('getAllCoursesAdmin should allow filtering by tutorId and respect institution bounds', async () => {
      const res = await courseService.getAllCoursesAdmin({
        query: { tutorId: activeTutor._id.toString() },
        user: adminUser
      });

      expect(res.data.courses).toHaveLength(1);

      // Institution admin bound to specific institution
      const insAdminRes = await courseService.getAllCoursesAdmin({
        query: {},
        user: institutionAdmin
      });
      expect(insAdminRes.data.courses).toHaveLength(0); // course1 is public/non-institutional

      // Filters by status, category, featured, search
      const filteredRes = await courseService.getAllCoursesAdmin({
        query: { status: 'published', category: 'Development', featured: 'false', search: 'Python' },
        user: adminUser
      });
      expect(filteredRes.data.courses).toHaveLength(1);
    });
  });

  // =========================================================================
  // 10. Moderation & Admin Operations (toggleFeature, suspend, unsuspend, delete, approve, reject, flag)
  // =========================================================================
  describe('Course Moderation & Admin Operations', () => {
    let course;

    beforeEach(async () => {
      course = await Course.create(buildCourse(activeTutor._id, { status: 'published', featured: false }));
    });

    test('toggleFeatureCourse should toggle featured status for admin and 403 for non-admin', async () => {
      await expect(
        courseService.toggleFeatureCourse({ courseId: course._id, user: activeTutor })
      ).rejects.toMatchObject({ statusCode: 403 });

      await expect(
        courseService.toggleFeatureCourse({ courseId: new mongoose.Types.ObjectId(), user: adminUser })
      ).rejects.toMatchObject({ statusCode: 404 });

      const res = await courseService.toggleFeatureCourse({ courseId: course._id, user: adminUser });
      expect(res.data.featured).toBe(true);
      expect(res.message).toBe('Course marked as featured');
    });

    test('suspendCourse and unsuspendCourse lifecycle and error paths', async () => {
      await expect(
        courseService.suspendCourse({ courseId: new mongoose.Types.ObjectId(), user: adminUser })
      ).rejects.toMatchObject({ statusCode: 404 });

      await expect(
        courseService.suspendCourse({ courseId: course._id, user: activeTutor })
      ).rejects.toMatchObject({ statusCode: 403 });

      const suspendRes = await courseService.suspendCourse({
        courseId: course._id,
        user: adminUser,
        reason: 'Copyright violation'
      });

      expect(suspendRes.data.status).toBe('suspended');
      expect(suspendRes.data.reviewNotes).toBe('Copyright violation');
      expect(emailService.sendMail).toHaveBeenCalled();

      await expect(
        courseService.unsuspendCourse({ courseId: new mongoose.Types.ObjectId(), user: adminUser })
      ).rejects.toMatchObject({ statusCode: 404 });

      await expect(
        courseService.unsuspendCourse({ courseId: course._id, user: activeTutor })
      ).rejects.toMatchObject({ statusCode: 403 });

      const unsuspendRes = await courseService.unsuspendCourse({ courseId: course._id, user: adminUser });
      expect(unsuspendRes.data.status).toBe('published');
    });

    test('deleteCourse should soft delete and cascade assignment deactivation', async () => {
      await expect(
        courseService.deleteCourse({ courseId: new mongoose.Types.ObjectId(), user: activeTutor })
      ).rejects.toMatchObject({ statusCode: 404 });

      await expect(
        courseService.deleteCourse({ courseId: course._id, user: otherTutor })
      ).rejects.toMatchObject({ statusCode: 403 });

      const res = await courseService.deleteCourse({ courseId: course._id, user: activeTutor });
      expect(res.data.status).toBe('deleted');
      expect(res.data.deletedAt).not.toBeNull();
      expect(institutionService.deactivateAssignmentsForCourse).toHaveBeenCalledWith(course._id);
    });

    test('approveCourse and rejectCourseReview lifecycle and error paths', async () => {
      await expect(
        courseService.approveCourse({ courseId: new mongoose.Types.ObjectId(), user: adminUser })
      ).rejects.toMatchObject({ statusCode: 404 });

      await expect(
        courseService.approveCourse({ courseId: course._id, user: activeTutor })
      ).rejects.toMatchObject({ statusCode: 403 });

      course.status = 'review_pending';
      await course.save();

      const approveRes = await courseService.approveCourse({
        courseId: course._id,
        user: adminUser,
        sendNotification: true
      });
      expect(approveRes.data.status).toBe('published');
      expect(approveRes.data.reviewNotes).toContain('approved');

      await expect(
        courseService.rejectCourseReview({ courseId: new mongoose.Types.ObjectId(), user: adminUser })
      ).rejects.toMatchObject({ statusCode: 404 });

      await expect(
        courseService.rejectCourseReview({ courseId: course._id, user: activeTutor })
      ).rejects.toMatchObject({ statusCode: 403 });

      const rejectRes = await courseService.rejectCourseReview({
        courseId: course._id,
        user: adminUser,
        feedback: 'Incomplete audio'
      });
      expect(rejectRes.data.status).toBe('unpublished');
      expect(rejectRes.data.reviewNotes).toBe('Incomplete audio');
      expect(emailService.sendMail).toHaveBeenCalled();
    });

    test('flagCourseForReview should mark course as flagged and log audit', async () => {
      await expect(
        courseService.flagCourseForReview({ courseId: new mongoose.Types.ObjectId(), user: adminUser })
      ).rejects.toMatchObject({ statusCode: 404 });

      await expect(
        courseService.flagCourseForReview({ courseId: course._id, user: activeTutor })
      ).rejects.toMatchObject({ statusCode: 403 });

      const res = await courseService.flagCourseForReview({
        courseId: course._id,
        user: adminUser,
        reason: 'Outdated content reported'
      });

      expect(res.data.flaggedForReview).toBe(true);
      expect(res.data.flagReviewReason).toBe('Outdated content reported');
      expect(auditService.logCourseAction).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 11. updateThumbnail, getCourseAuditLogs & submitCourseForReview
  // =========================================================================
  describe('updateThumbnail, getCourseAuditLogs & submitCourseForReview', () => {
    let course;

    beforeEach(async () => {
      course = await Course.create(buildCourse(activeTutor._id, { status: 'draft' }));
    });

    test('updateThumbnail should upload image and persist URL', async () => {
      const mockFile = { originalname: 'thumb.png', buffer: Buffer.from('image') };
      const res = await courseService.updateThumbnail({
        courseId: course._id,
        file: mockFile,
        user: activeTutor
      });

      expect(res.data.thumbnailUrl).toBe('https://storage.example.com/thumb.jpg');
      const updated = await Course.findById(course._id);
      expect(updated.thumbnailUrl).toBe('https://storage.example.com/thumb.jpg');
    });

    test('updateThumbnail should throw 400 if file is missing', async () => {
      await expect(
        courseService.updateThumbnail({ courseId: course._id, file: null, user: activeTutor })
      ).rejects.toMatchObject({ statusCode: 400, message: 'No file provided' });
    });

    test('getCourseAuditLogs should return logs for course author', async () => {
      const res = await courseService.getCourseAuditLogs({ courseId: course._id, user: activeTutor });
      expect(res.data).toEqual([{ action: 'test_action' }]);
    });

    test('submitCourseForReview should transition draft to review_pending and trigger alert', async () => {
      const res = await courseService.submitCourseForReview({ courseId: course._id, user: activeTutor });
      expect(res.data.status).toBe('review_pending');
      expect(notificationService.triggerCourseReviewSubmittedAlert).toHaveBeenCalled();

      // Published course cannot be submitted for review
      res.data.status = 'published';
      await res.data.save();
      await expect(
        courseService.submitCourseForReview({ courseId: course._id, user: activeTutor })
      ).rejects.toMatchObject({ statusCode: 400, message: 'Published courses cannot be submitted for review' });
    });
  });

  // =========================================================================
  // 12. getTutorAnalytics
  // =========================================================================
  describe('getTutorAnalytics', () => {
    test('should return empty metrics structure when tutor has no courses', async () => {
      const res = await courseService.getTutorAnalytics({ user: otherTutor });
      expect(res.message).toBe('No courses found for this tutor');
      expect(res.data.courses).toEqual([]);
      expect(res.data.overallWatchTime).toBe(0);
      expect(res.data.engagementScore).toBe(0);
    });

    test('should compute watch time, drop-offs, quiz stats and engagement score', async () => {
      const course = await Course.create(buildCourse(activeTutor._id, { status: 'published' }));
      const mod = await Module.create(buildModule(course._id));
      const videoLesson = await Lesson.create(buildLesson(course._id, mod._id, { type: 'video', order: 1 }));
      const quizLesson = await Lesson.create(buildLesson(course._id, mod._id, { type: 'quiz', order: 2 }));

      await Enrollment.create({
        userId: learner._id,
        courseId: course._id,
        status: 'active',
        enrollmentType: 'free',
        progressPercentage: 80,
        lastAccessedAt: new Date()
      });

      await Progress.create({
        userId: learner._id,
        courseId: course._id,
        completedLessons: [videoLesson._id],
        videoProgress: [{ lessonId: videoLesson._id, secondsWatched: 3600 }]
      });

      await QuizAttempt.create({
        userId: learner._id,
        courseId: course._id,
        lessonId: quizLesson._id,
        attemptNumber: 1,
        percentage: 90
      });

      const res = await courseService.getTutorAnalytics({ user: activeTutor, courseId: course._id });
      expect(res.data.overallWatchTime).toBe(1.0); // 3600s = 1.0 hr
      expect(res.data.selectedCourseAnalytics.lessonDropOffs).toHaveLength(2);
      expect(res.data.selectedCourseAnalytics.quizStats).toHaveLength(1);
      expect(res.data.selectedCourseAnalytics.quizStats[0].avgScore).toBe(90);
      expect(res.data.engagementScore).toBeGreaterThan(0);
    });
  });
});
