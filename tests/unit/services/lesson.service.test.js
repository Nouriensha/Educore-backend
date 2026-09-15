const mongoose = require('mongoose');
const lessonService = require('../../../src/services/lesson.service');
const Lesson = require('../../../src/models/lesson.model');
const Module = require('../../../src/models/module.model');
const Course = require('../../../src/models/course.model');
const User = require('../../../src/models/user.model');
const Enrollment = require('../../../src/models/enrollment.model');
const Progress = require('../../../src/models/progress.model');

const storageService = require('../../../src/services/storage.service');
const auditService = require('../../../src/services/audit.service');

const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { buildUser } = require('../../fixtures/user.fixture');
const { buildCourse } = require('../../fixtures/course.fixture');
const { buildModule } = require('../../fixtures/module.fixture');
const { buildLesson } = require('../../fixtures/lesson.fixture');
const { buildEnrollment } = require('../../fixtures/enrollment.fixture');

// Mock external services
jest.mock('../../../src/services/storage.service', () => ({
  uploadAttachment: jest.fn(),
  uploadSubtitle: jest.fn(),
  deleteResource: jest.fn()
}));

jest.mock('../../../src/services/audit.service', () => ({
  logCourseAction: jest.fn().mockResolvedValue({})
}));

jest.mock('../../../src/services/notification.service', () => ({
  createNotification: jest.fn().mockResolvedValue({})
}));

jest.mock('../../../src/services/email.service', () => ({
  sendVideoReadyEmail: jest.fn().mockResolvedValue({})
}));

describe('Lesson Service Unit Tests (src/services/lesson.service.js)', () => {
  let author;
  let otherTutor;
  let adminUser;
  let learner;
  let course;
  let moduleDoc;

  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    author = await User.create(buildUser({ role: 'tutor' }));
    otherTutor = await User.create(buildUser({ role: 'tutor' }));
    adminUser = await User.create(buildUser({ role: 'admin' }));
    learner = await User.create(buildUser({ role: 'learner' }));

    course = await Course.create(buildCourse(author._id, { status: 'published' }));
    moduleDoc = await Module.create(buildModule(course._id, { order: 1, isPublished: true }));
  });

  afterEach(async () => {
    await clearDB();
  });

  // ======================================================
  // 1. CREATE LESSON
  // ======================================================
  describe('createLesson', () => {
    it('should successfully create a new lesson and recalculate course structure', async () => {
      const payload = {
        title: 'New Video Lesson',
        description: 'Lesson description',
        type: 'video',
        videoUrl: 'https://example.com/video.mp4',
        durationInMinutes: 15,
        isPreview: true
      };

      const result = await lessonService.createLesson({
        moduleId: moduleDoc._id,
        payload,
        user: author
      });

      expect(result.message).toBe('Lesson created successfully');
      expect(result.data).toBeDefined();
      expect(result.data.title).toBe(payload.title);
      expect(result.data.order).toBe(1);
      expect(result.data.isPublished).toBe(true);

      const dbLesson = await Lesson.findById(result.data._id);
      expect(dbLesson).toBeDefined();
      expect(dbLesson.title).toBe(payload.title);

      const updatedCourse = await Course.findById(course._id);
      expect(updatedCourse.totalLessons).toBe(1);
      expect(updatedCourse.durationInMinutes).toBe(15);

      expect(auditService.logCourseAction).toHaveBeenCalledWith(
        expect.objectContaining({
          courseId: course._id,
          userId: author._id,
          action: 'curriculum_update'
        })
      );
    });

    it('should create lesson as admin user even if not author', async () => {
      const payload = { title: 'Admin Created Lesson' };

      const result = await lessonService.createLesson({
        moduleId: moduleDoc._id,
        payload,
        user: adminUser
      });

      expect(result.data.title).toBe('Admin Created Lesson');
    });

    it('should shift orders of subsequent lessons when inserting a non-assignment before existing assignments', async () => {
      // Create an existing assignment lesson with order 1
      await Lesson.create(buildLesson(course._id, moduleDoc._id, {
        title: 'Existing Assignment',
        type: 'assignment',
        order: 1
      }));

      // Create a new video lesson
      const result = await lessonService.createLesson({
        moduleId: moduleDoc._id,
        payload: { title: 'First Video', type: 'video' },
        user: author
      });

      expect(result.data.order).toBe(1);

      // Verify the assignment lesson order shifted to 2
      const assignmentLesson = await Lesson.findOne({ title: 'Existing Assignment' });
      expect(assignmentLesson.order).toBe(2);
    });

    it('should notify enrolled learners when published lesson is added to published course', async () => {
      const notificationService = require('../../../src/services/notification.service');
      await Enrollment.create(buildEnrollment(learner._id, course._id, { status: 'active' }));

      await lessonService.createLesson({
        moduleId: moduleDoc._id,
        payload: { title: 'Notified Lesson', isPublished: true },
        user: author
      });

      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: learner._id,
          title: 'New Lesson Added'
        })
      );
    });

    it('should throw 404 MODULE_NOT_FOUND if module does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      await expect(
        lessonService.createLesson({
          moduleId: nonExistentId,
          payload: { title: 'Test' },
          user: author
        })
      ).rejects.toThrow('Module not found');
    });

    it('should throw 404 COURSE_NOT_FOUND if parent course is deleted', async () => {
      await Course.findByIdAndUpdate(course._id, { deletedAt: new Date() });

      await expect(
        lessonService.createLesson({
          moduleId: moduleDoc._id,
          payload: { title: 'Test' },
          user: author
        })
      ).rejects.toThrow('Course not found');
    });

    it('should throw 403 ACCESS_DENIED if user is not author or admin', async () => {
      await expect(
        lessonService.createLesson({
          moduleId: moduleDoc._id,
          payload: { title: 'Unauthorized Lesson' },
          user: otherTutor
        })
      ).rejects.toThrow('Not authorized');
    });
  });

  // ======================================================
  // 2. GET LESSON BY ID
  // ======================================================
  describe('getLessonById', () => {
    let lessonDoc;

    beforeEach(async () => {
      lessonDoc = await Lesson.create(buildLesson(course._id, moduleDoc._id, {
        title: 'Target Lesson',
        videoUrl: '/uploads/videos/test.mp4',
        isPreview: false
      }));
    });

    it('should allow author to view lesson and sign video URL', async () => {
      const result = await lessonService.getLessonById({
        lessonId: lessonDoc._id,
        user: author
      });

      expect(result.message).toBe('Lesson fetched successfully');
      expect((result.data._id || result.data.id).toString()).toBe(lessonDoc._id.toString());
      expect(result.data.videoUrl).toContain('token=');
    });

    it('should allow enrolled learner to view lesson and return progress secondsWatched', async () => {
      await Enrollment.create(buildEnrollment(learner._id, course._id, { status: 'active' }));
      await Progress.create({
        userId: learner._id,
        courseId: course._id,
        videoProgress: [{ lessonId: lessonDoc._id, secondsWatched: 120 }]
      });

      const result = await lessonService.getLessonById({
        lessonId: lessonDoc._id,
        user: learner
      });

      expect(result.data.secondsWatched).toBe(120);
    });

    it('should allow non-enrolled user to view preview lesson', async () => {
      await Lesson.findByIdAndUpdate(lessonDoc._id, { isPreview: true });

      const result = await lessonService.getLessonById({
        lessonId: lessonDoc._id,
        user: learner
      });

      expect(result.data.title).toBe('Target Lesson');
    });

    it('should throw 403 ACCESS_DENIED if non-enrolled learner attempts to view non-preview lesson', async () => {
      await expect(
        lessonService.getLessonById({
          lessonId: lessonDoc._id,
          user: learner
        })
      ).rejects.toThrow('Course enrollment is required to view this lesson');
    });

    it('should enforce sequential course lock: throw 403 if previous module is locked', async () => {
      await Course.findByIdAndUpdate(course._id, { isSequential: true });
      await Enrollment.create(buildEnrollment(learner._id, course._id, { status: 'active' }));

      // Create module 2 and lesson in module 2
      const module2 = await Module.create(buildModule(course._id, { order: 2, isPublished: true }));
      const lesson2 = await Lesson.create(buildLesson(course._id, module2._id, { order: 1, isPublished: true }));

      // Learner hasn't completed module 1 lessonDoc
      await expect(
        lessonService.getLessonById({
          lessonId: lesson2._id,
          user: learner
        })
      ).rejects.toThrow('This lesson is locked until the previous module is completed');
    });

    it('should enforce sequential course lock: throw 403 if previous lesson in same module is incomplete', async () => {
      await Course.findByIdAndUpdate(course._id, { isSequential: true });
      await Enrollment.create(buildEnrollment(learner._id, course._id, { status: 'active' }));

      const lesson2 = await Lesson.create(buildLesson(course._id, moduleDoc._id, { order: 2, isPublished: true }));

      await expect(
        lessonService.getLessonById({
          lessonId: lesson2._id,
          user: learner
        })
      ).rejects.toThrow('This lesson is locked until the previous lesson is completed');
    });

    it('should allow accessing sequential lesson if previous lesson is completed', async () => {
      await Course.findByIdAndUpdate(course._id, { isSequential: true });
      await Enrollment.create(buildEnrollment(learner._id, course._id, { status: 'active' }));

      const lesson2 = await Lesson.create(buildLesson(course._id, moduleDoc._id, { order: 2, isPublished: true }));
      await Progress.create({
        userId: learner._id,
        courseId: course._id,
        completedLessons: [lessonDoc._id]
      });

      const result = await lessonService.getLessonById({
        lessonId: lesson2._id,
        user: learner
      });

      expect(result.data.title).toBe(lesson2.title);
    });

    it('should throw 404 LESSON_NOT_FOUND if lesson does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      await expect(
        lessonService.getLessonById({
          lessonId: nonExistentId,
          user: author
        })
      ).rejects.toThrow('Lesson not found');
    });
  });

  // ======================================================
  // 3. UPDATE LESSON
  // ======================================================
  describe('updateLesson', () => {
    let lessonDoc;

    beforeEach(async () => {
      lessonDoc = await Lesson.create(buildLesson(course._id, moduleDoc._id, {
        title: 'Original Title',
        isPublished: false
      }));
    });

    it('should successfully update lesson attributes', async () => {
      const result = await lessonService.updateLesson({
        lessonId: lessonDoc._id,
        payload: { title: 'Updated Title', description: 'New description' },
        user: author
      });

      expect(result.message).toBe('Lesson updated successfully');
      expect(result.data.title).toBe('Updated Title');
      expect(result.data.description).toBe('New description');

      const updated = await Lesson.findById(lessonDoc._id);
      expect(updated.title).toBe('Updated Title');
    });

    it('should prevent temporary signed video URLs from overwriting raw videoUrl', async () => {
      await lessonService.updateLesson({
        lessonId: lessonDoc._id,
        payload: { videoUrl: 'https://cdn.example.com/video/stream?token=abc12345' },
        user: author
      });

      const updated = await Lesson.findById(lessonDoc._id);
      expect(updated.videoUrl).toBe('https://example.com/video.mp4');
    });

    it('should trigger video ready notifications when muxPlaybackId is newly assigned', async () => {
      const notificationService = require('../../../src/services/notification.service');
      const emailService = require('../../../src/services/email.service');

      await lessonService.updateLesson({
        lessonId: lessonDoc._id,
        payload: { muxPlaybackId: 'mux_playback_xyz' },
        user: author
      });

      // Allow background async triggerVideoReadyNotifications (multiple awaits) to execute
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: author._id,
          type: 'video_ready'
        })
      );
      expect(emailService.sendVideoReadyEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: author.email
        })
      );
    });

    it('should notify enrolled learners when lesson is newly published', async () => {
      const notificationService = require('../../../src/services/notification.service');
      await Enrollment.create(buildEnrollment(learner._id, course._id, { status: 'active' }));

      await lessonService.updateLesson({
        lessonId: lessonDoc._id,
        payload: { isPublished: true },
        user: author
      });

      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: learner._id,
          title: 'New Lesson Added'
        })
      );
    });

    it('should throw 403 LESSON_ACCESS_DENIED if user is not author or admin', async () => {
      await expect(
        lessonService.updateLesson({
          lessonId: lessonDoc._id,
          payload: { title: 'Hacked Title' },
          user: otherTutor
        })
      ).rejects.toThrow('You cannot edit this lesson');
    });

    it('should throw 404 LESSON_NOT_FOUND if lesson is soft-deleted or non-existent', async () => {
      await Lesson.findByIdAndUpdate(lessonDoc._id, { deletedAt: new Date() });

      await expect(
        lessonService.updateLesson({
          lessonId: lessonDoc._id,
          payload: { title: 'Update' },
          user: author
        })
      ).rejects.toThrow('Lesson not found');
    });
  });

  // ======================================================
  // 4. DELETE LESSON
  // ======================================================
  describe('deleteLesson', () => {
    let lessonDoc;

    beforeEach(async () => {
      lessonDoc = await Lesson.create(buildLesson(course._id, moduleDoc._id));
    });

    it('should soft delete lesson and recalculate course structure', async () => {
      const result = await lessonService.deleteLesson({
        lessonId: lessonDoc._id,
        user: author
      });

      expect(result.message).toBe('Lesson deleted successfully');

      const deleted = await Lesson.findById(lessonDoc._id);
      expect(deleted.deletedAt).toBeDefined();

      const updatedCourse = await Course.findById(course._id);
      expect(updatedCourse.totalLessons).toBe(0);

      expect(auditService.logCourseAction).toHaveBeenCalledWith(
        expect.objectContaining({
          courseId: course._id,
          action: 'curriculum_update'
        })
      );
    });

    it('should throw 403 LESSON_DELETE_DENIED if unauthorized user attempts deletion', async () => {
      await expect(
        lessonService.deleteLesson({
          lessonId: lessonDoc._id,
          user: otherTutor
        })
      ).rejects.toThrow('You cannot delete this lesson');
    });

    it('should throw 404 LESSON_NOT_FOUND if lesson does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      await expect(
        lessonService.deleteLesson({
          lessonId: nonExistentId,
          user: author
        })
      ).rejects.toThrow('Lesson not found');
    });
  });

  // ======================================================
  // 5. REORDER LESSONS
  // ======================================================
  describe('reorderLessons', () => {
    let l1;
    let l2;
    let l3;

    beforeEach(async () => {
      l1 = await Lesson.create(buildLesson(course._id, moduleDoc._id, { title: 'L1', order: 1 }));
      l2 = await Lesson.create(buildLesson(course._id, moduleDoc._id, { title: 'L2', order: 2 }));
      l3 = await Lesson.create(buildLesson(course._id, moduleDoc._id, { title: 'L3', order: 3 }));
    });

    it('should bulk update lesson order positions', async () => {
      const reorderedIds = [l3._id.toString(), l1._id.toString(), l2._id.toString()];

      const result = await lessonService.reorderLessons({
        moduleId: moduleDoc._id,
        orderedLessonIds: reorderedIds,
        user: author
      });

      expect(result.message).toBe('Lessons reordered successfully');
      expect(result.data).toBe(true);

      const dbL1 = await Lesson.findById(l1._id);
      const dbL2 = await Lesson.findById(l2._id);
      const dbL3 = await Lesson.findById(l3._id);

      expect(dbL3.order).toBe(1);
      expect(dbL1.order).toBe(2);
      expect(dbL2.order).toBe(3);
    });

    it('should throw 400 INVALID_LESSON_ORDER if payload is not an array', async () => {
      await expect(
        lessonService.reorderLessons({
          moduleId: moduleDoc._id,
          orderedLessonIds: 'invalid_payload',
          user: author
        })
      ).rejects.toThrow('Invalid lesson order payload');
    });

    it('should throw 400 INVALID_LESSON_ORDER if lesson count mismatches module lessons count', async () => {
      await expect(
        lessonService.reorderLessons({
          moduleId: moduleDoc._id,
          orderedLessonIds: [l1._id.toString()],
          user: author
        })
      ).rejects.toThrow('Lesson count mismatch');
    });

    it('should throw 400 INVALID_LESSON_ID if an unknown lesson ID is included', async () => {
      const unknownId = new mongoose.Types.ObjectId().toString();
      await expect(
        lessonService.reorderLessons({
          moduleId: moduleDoc._id,
          orderedLessonIds: [l1._id.toString(), l2._id.toString(), unknownId],
          user: author
        })
      ).rejects.toThrow(`Invalid lesson id: ${unknownId}`);
    });

    it('should throw 403 LESSON_REORDER_DENIED if non-owner tutor attempts reorder', async () => {
      await expect(
        lessonService.reorderLessons({
          moduleId: moduleDoc._id,
          orderedLessonIds: [l1._id.toString(), l2._id.toString(), l3._id.toString()],
          user: otherTutor
        })
      ).rejects.toThrow('You cannot reorder lessons');
    });
  });

  // ======================================================
  // 6. ADD ATTACHMENT
  // ======================================================
  describe('addAttachment', () => {
    let lessonDoc;

    beforeEach(async () => {
      lessonDoc = await Lesson.create(buildLesson(course._id, moduleDoc._id));
    });

    it('should upload attachment via storageService and add to lesson attachments array', async () => {
      const mockAttachmentData = {
        title: 'Notes.pdf',
        fileUrl: 'https://cloudinary.com/notes.pdf',
        publicId: 'attach_123.pdf',
        resourceType: 'raw',
        mimeType: 'application/pdf',
        bytes: 1024
      };
      storageService.uploadAttachment.mockResolvedValue(mockAttachmentData);

      const fakeFile = { originalname: 'Notes.pdf', buffer: Buffer.from('PDF content') };

      const result = await lessonService.addAttachment({
        lessonId: lessonDoc._id,
        file: fakeFile,
        user: author
      });

      expect(result.message).toBe('Attachment added successfully');
      expect(result.data.attachments).toHaveLength(1);
      expect(result.data.attachments[0].title).toBe('Notes.pdf');

      const updated = await Lesson.findById(lessonDoc._id);
      expect(updated.attachments).toHaveLength(1);
    });

    it('should initialize attachments array if null and add attachment', async () => {
      await Lesson.findByIdAndUpdate(lessonDoc._id, { attachments: null });
      storageService.uploadAttachment.mockResolvedValue({
        title: 'Init.pdf',
        fileUrl: 'https://cloudinary.com/init.pdf'
      });

      const result = await lessonService.addAttachment({
        lessonId: lessonDoc._id,
        file: { originalname: 'Init.pdf', buffer: Buffer.from('data') },
        user: author
      });

      expect(result.data.attachments).toHaveLength(1);
    });

    it('should throw 400 ATTACHMENT_LIMIT_EXCEEDED if lesson already has 5 attachments', async () => {
      const dummyAttachments = [1, 2, 3, 4, 5].map((n) => ({
        title: `File ${n}.pdf`,
        fileUrl: `https://example.com/file${n}.pdf`
      }));

      await Lesson.findByIdAndUpdate(lessonDoc._id, { attachments: dummyAttachments });

      await expect(
        lessonService.addAttachment({
          lessonId: lessonDoc._id,
          file: { originalname: 'Extra.pdf' },
          user: author
        })
      ).rejects.toThrow('A maximum of 5 attachments are allowed per lesson');
    });

    it('should throw 403 ACCESS_DENIED if unauthorized user tries to add attachment', async () => {
      await expect(
        lessonService.addAttachment({
          lessonId: lessonDoc._id,
          file: { originalname: 'Notes.pdf' },
          user: otherTutor
        })
      ).rejects.toThrow('You are not authorized to edit this lesson');
    });
  });

  // ======================================================
  // 7. REMOVE ATTACHMENT
  // ======================================================
  describe('removeAttachment', () => {
    let lessonDoc;
    const attachId = new mongoose.Types.ObjectId();

    beforeEach(async () => {
      lessonDoc = await Lesson.create(buildLesson(course._id, moduleDoc._id, {
        attachments: [
          { _id: attachId, title: 'Doc.pdf', fileUrl: 'https://example.com/doc.pdf' }
        ]
      }));
    });

    it('should remove specified attachment from lesson', async () => {
      const result = await lessonService.removeAttachment({
        lessonId: lessonDoc._id,
        attachmentId: attachId.toString(),
        user: author
      });

      expect(result.message).toBe('Attachment removed successfully');
      expect(result.data.attachments).toHaveLength(0);

      const updated = await Lesson.findById(lessonDoc._id);
      expect(updated.attachments).toHaveLength(0);
    });

    it('should remove specified attachment from lesson by id string property', async () => {
      const customId = new mongoose.Types.ObjectId().toString();
      await Lesson.findByIdAndUpdate(lessonDoc._id, {
        attachments: [{ _id: customId, title: 'Doc.pdf', fileUrl: 'https://example.com/doc.pdf' }]
      });

      const result = await lessonService.removeAttachment({
        lessonId: lessonDoc._id,
        attachmentId: customId,
        user: author
      });

      expect(result.data.attachments).toHaveLength(0);
    });

    it('should throw 403 ACCESS_DENIED if non-owner tutor tries to remove attachment', async () => {
      await expect(
        lessonService.removeAttachment({
          lessonId: lessonDoc._id,
          attachmentId: attachId.toString(),
          user: otherTutor
        })
      ).rejects.toThrow('You are not authorized to edit this lesson');
    });
  });

  // ======================================================
  // 8. UPLOAD SUBTITLE
  // ======================================================
  describe('uploadSubtitle', () => {
    let lessonDoc;

    beforeEach(async () => {
      lessonDoc = await Lesson.create(buildLesson(course._id, moduleDoc._id));
    });

    it('should upload VTT subtitle file successfully', async () => {
      storageService.uploadSubtitle.mockResolvedValue({
        url: 'https://cloudinary.com/sub.vtt',
        publicId: 'sub_123.vtt',
        resourceType: 'raw'
      });

      const fakeFile = {
        originalname: 'captions.vtt',
        buffer: Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nHello World')
      };

      const result = await lessonService.uploadSubtitle({
        lessonId: lessonDoc._id,
        file: fakeFile,
        user: author
      });

      expect(result.message).toBe('Subtitle uploaded successfully');
      expect(result.data.subtitleUrl).toBe('https://cloudinary.com/sub.vtt');
      expect(result.data.subtitlePublicId).toBe('sub_123.vtt');
    });

    it('should convert SRT subtitle file to VTT before uploading', async () => {
      storageService.uploadSubtitle.mockResolvedValue({
        url: 'https://cloudinary.com/sub.vtt',
        publicId: 'sub_456.vtt',
        resourceType: 'raw'
      });

      const srtContent = '1\n00:00:01,000 --> 00:00:05,000\nSRT Subtitle';
      const fakeFile = {
        originalname: 'captions.srt',
        buffer: Buffer.from(srtContent, 'utf8')
      };

      await lessonService.uploadSubtitle({
        lessonId: lessonDoc._id,
        file: fakeFile,
        user: author
      });

      expect(storageService.uploadSubtitle).toHaveBeenCalledWith(
        expect.objectContaining({
          file: expect.objectContaining({
            originalname: 'captions.vtt'
          })
        })
      );
    });

    it('should delete previous subtitle asset when replacing subtitle', async () => {
      await Lesson.findByIdAndUpdate(lessonDoc._id, {
        subtitlePublicId: 'old_sub_999.vtt',
        subtitleResourceType: 'raw'
      });

      storageService.uploadSubtitle.mockResolvedValue({
        url: 'https://cloudinary.com/new_sub.vtt',
        publicId: 'new_sub_111.vtt',
        resourceType: 'raw'
      });

      const fakeFile = {
        originalname: 'captions.vtt',
        buffer: Buffer.from('WEBVTT\n\nSubtitle test')
      };

      await lessonService.uploadSubtitle({
        lessonId: lessonDoc._id,
        file: fakeFile,
        user: author
      });

      expect(storageService.deleteResource).toHaveBeenCalledWith({
        publicId: 'old_sub_999.vtt',
        resourceType: 'raw'
      });
    });

    it('should rollback uploaded Cloudinary subtitle asset if DB save fails', async () => {
      storageService.uploadSubtitle.mockResolvedValue({
        url: 'https://cloudinary.com/rollback.vtt',
        publicId: 'rollback_pub_123',
        resourceType: 'raw'
      });

      jest.spyOn(Lesson.prototype, 'save').mockRejectedValueOnce(new Error('DB Save Failed'));

      const fakeFile = {
        originalname: 'captions.vtt',
        buffer: Buffer.from('WEBVTT\n\nRollback test')
      };

      await expect(
        lessonService.uploadSubtitle({
          lessonId: lessonDoc._id,
          file: fakeFile,
          user: author
        })
      ).rejects.toThrow('DB Save Failed');

      expect(storageService.deleteResource).toHaveBeenCalledWith({
        publicId: 'rollback_pub_123',
        resourceType: 'raw'
      });
    });

    it('should throw 400 INVALID_SUBTITLE_TYPE for unsupported file extension', async () => {
      const fakeFile = {
        originalname: 'subtitles.txt',
        buffer: Buffer.from('plain text')
      };

      await expect(
        lessonService.uploadSubtitle({
          lessonId: lessonDoc._id,
          file: fakeFile,
          user: author
        })
      ).rejects.toThrow('Unsupported subtitle file type. Allowed: .vtt, .srt');
    });

    it('should throw 413 SUBTITLE_TOO_LARGE if file exceeds 2MB limit', async () => {
      const largeBuffer = Buffer.alloc(3 * 1024 * 1024);
      const fakeFile = {
        originalname: 'large.vtt',
        buffer: largeBuffer
      };

      await expect(
        lessonService.uploadSubtitle({
          lessonId: lessonDoc._id,
          file: fakeFile,
          user: author
        })
      ).rejects.toThrow('Subtitle file is too large (max 2MB)');
    });
  });

  // ======================================================
  // 9. REMOVE SUBTITLE
  // ======================================================
  describe('removeSubtitle', () => {
    let lessonDoc;

    beforeEach(async () => {
      lessonDoc = await Lesson.create(buildLesson(course._id, moduleDoc._id, {
        subtitleUrl: 'https://cloudinary.com/sub.vtt',
        subtitlePublicId: 'sub_to_delete.vtt',
        subtitleResourceType: 'raw'
      }));
    });

    it('should delete storage resource and clear subtitle fields on lesson', async () => {
      const result = await lessonService.removeSubtitle({
        lessonId: lessonDoc._id,
        user: author
      });

      expect(result.message).toBe('Subtitle removed successfully');
      expect(result.data.subtitleUrl).toBeNull();
      expect(result.data.subtitlePublicId).toBeNull();

      expect(storageService.deleteResource).toHaveBeenCalledWith({
        publicId: 'sub_to_delete.vtt',
        resourceType: 'raw'
      });

      const updated = await Lesson.findById(lessonDoc._id);
      expect(updated.subtitleUrl).toBeNull();
    });

    it('should throw 403 ACCESS_DENIED if non-owner tutor attempts to remove subtitle', async () => {
      await expect(
        lessonService.removeSubtitle({
          lessonId: lessonDoc._id,
          user: otherTutor
        })
      ).rejects.toThrow('You are not authorized to edit this lesson');
    });
  });
});
