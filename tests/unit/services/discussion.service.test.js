const mongoose = require('mongoose');
const discussionService = require('../../../src/services/discussion.service');
const DiscussionPost = require('../../../src/models/discussionPost.model');
const DiscussionUnbanRequest = require('../../../src/models/discussionUnbanRequest.model');
const User = require('../../../src/models/user.model');
const Course = require('../../../src/models/course.model');
const Lesson = require('../../../src/models/lesson.model');
const Module = require('../../../src/models/module.model');
const Enrollment = require('../../../src/models/enrollment.model');

const notificationService = require('../../../src/services/notification.service');
const emailService = require('../../../src/services/email.service');

const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { buildUser } = require('../../fixtures/user.fixture');
const { buildCourse } = require('../../fixtures/course.fixture');
const { buildModule } = require('../../fixtures/module.fixture');
const { buildLesson } = require('../../fixtures/lesson.fixture');
const { buildEnrollment } = require('../../fixtures/enrollment.fixture');

// Mock external notification & email services
jest.mock('../../../src/services/notification.service', () => ({
  createNotification: jest.fn().mockResolvedValue({})
}));

jest.mock('../../../src/services/email.service', () => ({
  sendNewQuestionAlertEmail: jest.fn().mockResolvedValue({}),
  sendNewReplyAlertEmail: jest.fn().mockResolvedValue({}),
  sendReportAlertEmail: jest.fn().mockResolvedValue({}),
  sendAdminReportAlertEmail: jest.fn().mockResolvedValue({})
}));

describe('Discussion Service Unit Tests (src/services/discussion.service.js)', () => {
  let tutor;
  let otherTutor;
  let admin;
  let learner;
  let nonEnrolledLearner;
  let course;
  let moduleDoc;
  let lesson;

  beforeAll(async () => {
    await connectDB();
    await DiscussionPost.init();
    await DiscussionUnbanRequest.init();
  });

  afterAll(async () => {
    await closeDB();
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    tutor = await User.create(buildUser({ role: 'tutor' }));
    otherTutor = await User.create(buildUser({ role: 'tutor' }));
    admin = await User.create(buildUser({ role: 'platform_owner' }));
    learner = await User.create(buildUser({ role: 'learner' }));
    nonEnrolledLearner = await User.create(buildUser({ role: 'learner' }));

    course = await Course.create(buildCourse(tutor._id, { status: 'published' }));
    moduleDoc = await Module.create(buildModule(course._id, { order: 1 }));
    lesson = await Lesson.create(buildLesson(course._id, moduleDoc._id));

    await Enrollment.create(buildEnrollment(learner._id, course._id, { status: 'active' }));
  });

  afterEach(async () => {
    await clearDB();
  });

  // ======================================================
  // 1. CREATE POST / REPLY
  // ======================================================
  describe('createPost', () => {
    it('should successfully create a top-level question post and alert tutor', async () => {
      const result = await discussionService.createPost({
        courseId: course._id,
        lessonId: lesson._id,
        authorId: learner._id,
        content: 'How do promises work in JavaScript?'
      });

      expect(result._id).toBeDefined();
      expect(result.content).toBe('How do promises work in JavaScript?');
      expect(result.author.id).toBe(learner._id.toString());
      expect(result.author.name).toBe(learner.name);

      const dbPost = await DiscussionPost.findById(result._id);
      expect(dbPost).toBeDefined();
      expect(dbPost.content).toBe('How do promises work in JavaScript?');

      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: tutor._id.toString(),
          title: 'New Question Posted'
        })
      );
      expect(emailService.sendNewQuestionAlertEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: tutor.email,
          tutorName: tutor.name
        })
      );
    });

    it('should sanitize HTML/XSS scripts in post content', async () => {
      const xssContent = 'Safe text <script>alert("hacked")</script> <iframe src="bad.html"></iframe>';

      const result = await discussionService.createPost({
        courseId: course._id,
        lessonId: lesson._id,
        authorId: learner._id,
        content: xssContent
      });

      expect(result.content).toBe('Safe text');
      expect(result.content).not.toContain('<script>');
    });

    it('should create a reply to an existing post and notify question author', async () => {
      const parentPost = await DiscussionPost.create({
        courseId: course._id,
        lessonId: lesson._id,
        authorId: learner._id,
        content: 'Original Question'
      });

      const replyResult = await discussionService.createPost({
        courseId: course._id,
        lessonId: lesson._id,
        parentId: parentPost._id,
        authorId: tutor._id,
        content: 'Here is the answer to your question.'
      });

      expect(replyResult.parentId.toString()).toBe(parentPost._id.toString());
      expect(replyResult.content).toBe('Here is the answer to your question.');

      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: learner._id.toString(),
          title: 'New Reply Posted'
        })
      );
      expect(emailService.sendNewReplyAlertEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: learner.email,
          replierName: tutor.name
        })
      );
    });

    it('should allow course tutor and admin to create posts without course enrollment', async () => {
      const tutorPost = await discussionService.createPost({
        courseId: course._id,
        lessonId: lesson._id,
        authorId: tutor._id,
        content: 'Tutor Announcement'
      });
      expect(tutorPost._id).toBeDefined();

      const adminPost = await discussionService.createPost({
        courseId: course._id,
        lessonId: lesson._id,
        authorId: admin._id,
        content: 'Admin Announcement'
      });
      expect(adminPost._id).toBeDefined();
    });

    it('should validate image attachment when provided', async () => {
      const imagePayload = {
        fileUrl: 'https://cloudinary.com/diagram.png',
        publicId: 'img_diagram_123',
        mimeType: 'image/png',
        size: 1024 * 1024
      };

      const result = await discussionService.createPost({
        courseId: course._id,
        lessonId: lesson._id,
        authorId: learner._id,
        content: 'Check out my architecture diagram',
        image: imagePayload
      });

      expect(result.image.fileUrl).toBe('https://cloudinary.com/diagram.png');
    });

    it('should throw 404 USER_NOT_FOUND if author user does not exist', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await expect(
        discussionService.createPost({
          courseId: course._id,
          lessonId: lesson._id,
          authorId: fakeId,
          content: 'Test'
        })
      ).rejects.toThrow('Author user not found');
    });

    it('should throw 403 DISCUSSION_BANNED if author user is banned from discussions', async () => {
      await User.findByIdAndUpdate(learner._id, { isDiscussionBanned: true });

      await expect(
        discussionService.createPost({
          courseId: course._id,
          lessonId: lesson._id,
          authorId: learner._id,
          content: 'Test post'
        })
      ).rejects.toThrow('You are banned from participating in discussions');
    });

    it('should throw 404 COURSE_NOT_FOUND if course does not exist', async () => {
      const fakeCourseId = new mongoose.Types.ObjectId();
      await expect(
        discussionService.createPost({
          courseId: fakeCourseId,
          lessonId: lesson._id,
          authorId: learner._id,
          content: 'Test'
        })
      ).rejects.toThrow('Course not found');
    });

    it('should throw 404 LESSON_NOT_FOUND if lesson does not exist', async () => {
      const fakeLessonId = new mongoose.Types.ObjectId();
      await expect(
        discussionService.createPost({
          courseId: course._id,
          lessonId: fakeLessonId,
          authorId: learner._id,
          content: 'Test'
        })
      ).rejects.toThrow('Lesson not found');
    });

    it('should throw 400 LESSON_COURSE_MISMATCH if lesson belongs to a different course', async () => {
      const otherCourse = await Course.create(buildCourse(tutor._id));
      const otherLesson = await Lesson.create(buildLesson(otherCourse._id, moduleDoc._id));

      await expect(
        discussionService.createPost({
          courseId: course._id,
          lessonId: otherLesson._id,
          authorId: learner._id,
          content: 'Cross-course test'
        })
      ).rejects.toThrow('Lesson does not belong to the specified course');
    });

    it('should throw 403 ENROLLMENT_REQUIRED if learner is not enrolled in the course', async () => {
      await expect(
        discussionService.createPost({
          courseId: course._id,
          lessonId: lesson._id,
          authorId: nonEnrolledLearner._id,
          content: 'Unenrolled student question'
        })
      ).rejects.toThrow('You must be enrolled in this course to participate in discussions');
    });

    it('should throw 400 NESTED_REPLIES_NOT_ALLOWED if replying to a reply (max 1 level)', async () => {
      const parentPost = await DiscussionPost.create({
        courseId: course._id,
        lessonId: lesson._id,
        authorId: learner._id,
        content: 'Original Question'
      });

      const firstReply = await DiscussionPost.create({
        courseId: course._id,
        lessonId: lesson._id,
        parentId: parentPost._id,
        authorId: tutor._id,
        content: 'First reply'
      });

      await expect(
        discussionService.createPost({
          courseId: course._id,
          lessonId: lesson._id,
          parentId: firstReply._id,
          authorId: learner._id,
          content: 'Second level nested reply'
        })
      ).rejects.toThrow('Replies are limited to a single level');
    });

    it('should throw 400 for invalid image properties', async () => {
      await expect(
        discussionService.createPost({
          courseId: course._id,
          lessonId: lesson._id,
          authorId: learner._id,
          content: 'Bad image',
          image: { mimeType: 'image/png' } // Missing fileUrl
        })
      ).rejects.toThrow('Image fileUrl is required');

      await expect(
        discussionService.createPost({
          courseId: course._id,
          lessonId: lesson._id,
          authorId: learner._id,
          content: 'Bad image type',
          image: { fileUrl: 'https://example.com/bad.bmp', mimeType: 'image/bmp' }
        })
      ).rejects.toThrow('Unsupported image type');

      await expect(
        discussionService.createPost({
          courseId: course._id,
          lessonId: lesson._id,
          authorId: learner._id,
          content: 'Overly large image',
          image: { fileUrl: 'https://example.com/huge.png', mimeType: 'image/png', size: 6 * 1024 * 1024 }
        })
      ).rejects.toThrow('Image size exceeds the 5MB limit');
    });
  });

  // ======================================================
  // 2. GET DISCUSSION POSTS
  // ======================================================
  describe('getDiscussionPosts', () => {
    let topPost1;
    let topPost2;
    let reply1;

    beforeEach(async () => {
      topPost1 = await DiscussionPost.create({
        courseId: course._id,
        lessonId: lesson._id,
        authorId: learner._id,
        content: 'First question',
        upvoteCount: 5,
        createdAt: new Date(Date.now() - 10000)
      });

      topPost2 = await DiscussionPost.create({
        courseId: course._id,
        lessonId: lesson._id,
        authorId: tutor._id,
        content: 'Pinned second question',
        isPinned: true,
        upvoteCount: 1,
        createdAt: new Date()
      });

      reply1 = await DiscussionPost.create({
        courseId: course._id,
        lessonId: lesson._id,
        parentId: topPost1._id,
        authorId: tutor._id,
        content: 'Tutor reply to first question'
      });
    });

    it('should return paginated posts with computed viewerState capabilities', async () => {
      const result = await discussionService.getDiscussionPosts({
        lessonId: lesson._id,
        currentUserId: learner._id
      });

      expect(result.posts).toHaveLength(2);
      expect(result.pagination.total).toBe(2);
      expect(result.isDiscussionBanned).toBe(false);

      // Pinned post should float to top
      expect(result.posts[0]._id.toString()).toBe(topPost2._id.toString());
      expect(result.posts[0].isPinned).toBe(true);

      // Second post should have replies
      const firstQuestion = result.posts.find(p => p._id.toString() === topPost1._id.toString());
      expect(firstQuestion.replies).toHaveLength(1);
      expect(firstQuestion.replies[0].content).toBe('Tutor reply to first question');

      // Verify viewerState capabilities for learner on own post vs tutor post
      expect(firstQuestion.viewerState.isAuthor).toBe(true);
      expect(firstQuestion.viewerState.canEdit).toBe(true);
      expect(firstQuestion.viewerState.canDelete).toBe(true);
      expect(firstQuestion.viewerState.canUpvote).toBe(false); // cannot upvote own post
    });

    it('should sort posts by popular when sortBy="popular"', async () => {
      const result = await discussionService.getDiscussionPosts({
        lessonId: lesson._id,
        sortBy: 'popular',
        currentUserId: learner._id
      });

      expect(result.posts).toHaveLength(2);
    });

    it('should preserve deleted posts with active replies (Thread Continuum Protection) with tombstone text', async () => {
      await DiscussionPost.findByIdAndUpdate(topPost1._id, { deletedAt: new Date() });

      const result = await discussionService.getDiscussionPosts({
        lessonId: lesson._id,
        currentUserId: learner._id
      });

      const deletedPost = result.posts.find(p => p._id.toString() === topPost1._id.toString());
      expect(deletedPost).toBeDefined();
      expect(deletedPost.content).toBe('This post was deleted by the author');
      expect(deletedPost.replies).toHaveLength(1);
    });

    it('should redact removed post content with moderator tombstone text', async () => {
      await DiscussionPost.findByIdAndUpdate(topPost1._id, { isRemoved: true });

      const result = await discussionService.getDiscussionPosts({
        lessonId: lesson._id,
        currentUserId: learner._id
      });

      const removedPost = result.posts.find(p => p._id.toString() === topPost1._id.toString());
      expect(removedPost).toBeDefined();
      expect(removedPost.content).toBe('This post was removed by a moderator');
    });

    it('should throw 401 AUTH_REQUIRED if currentUserId is missing', async () => {
      await expect(
        discussionService.getDiscussionPosts({ lessonId: lesson._id })
      ).rejects.toThrow('Authentication required to access discussions');
    });

    it('should throw 403 ENROLLMENT_REQUIRED for non-enrolled learner', async () => {
      await expect(
        discussionService.getDiscussionPosts({
          lessonId: lesson._id,
          currentUserId: nonEnrolledLearner._id
        })
      ).rejects.toThrow('You must be enrolled in this course to view discussions');
    });
  });

  // ======================================================
  // 3. UPVOTE / REMOVE UPVOTE
  // ======================================================
  describe('upvotePost & removeUpvote', () => {
    let targetPost;

    beforeEach(async () => {
      targetPost = await DiscussionPost.create({
        courseId: course._id,
        lessonId: lesson._id,
        authorId: tutor._id,
        content: 'Post for upvoting'
      });
    });

    it('should add upvote and increment upvoteCount atomically', async () => {
      const upvoted = await discussionService.upvotePost(targetPost._id, learner._id);

      expect(upvoted.upvoteCount).toBe(1);
      expect(upvoted.upvotes.map(id => id.toString())).toContain(learner._id.toString());

      const dbPost = await DiscussionPost.findById(targetPost._id);
      expect(dbPost.upvoteCount).toBe(1);
    });

    it('should prevent double-upvoting by the same user', async () => {
      await discussionService.upvotePost(targetPost._id, learner._id);
      await discussionService.upvotePost(targetPost._id, learner._id);

      const dbPost = await DiscussionPost.findById(targetPost._id);
      expect(dbPost.upvoteCount).toBe(1);
    });

    it('should throw 400 CANNOT_UPVOTE_OWN_POST if author tries to upvote own post', async () => {
      await expect(
        discussionService.upvotePost(targetPost._id, tutor._id)
      ).rejects.toThrow('Learner cannot upvote their own post');
    });

    it('should remove upvote and decrement upvoteCount', async () => {
      await discussionService.upvotePost(targetPost._id, learner._id);
      const unvoted = await discussionService.removeUpvote(targetPost._id, learner._id);

      expect(unvoted.upvoteCount).toBe(0);
      expect(unvoted.upvotes.map(id => id.toString())).not.toContain(learner._id.toString());
    });

    it('should throw 404 POST_NOT_FOUND if post does not exist or is soft-deleted', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await expect(discussionService.upvotePost(fakeId, learner._id)).rejects.toThrow('Post not found');
      await expect(discussionService.removeUpvote(fakeId, learner._id)).rejects.toThrow('Post not found');
    });
  });

  // ======================================================
  // 4. EDIT POST
  // ======================================================
  describe('editPost', () => {
    let postDoc;

    beforeEach(async () => {
      postDoc = await DiscussionPost.create({
        courseId: course._id,
        lessonId: lesson._id,
        authorId: learner._id,
        content: 'Original content before edit'
      });
    });

    it('should allow author to edit post content and sanitize HTML', async () => {
      const updated = await discussionService.editPost(
        postDoc._id,
        learner._id,
        learner.role,
        'Updated content <script>bad()</script>'
      );

      expect(updated.content).toBe('Updated content');

      const dbPost = await DiscussionPost.findById(postDoc._id);
      expect(dbPost.content).toBe('Updated content');
    });

    it('should throw 403 DISCUSSION_BANNED if author is banned', async () => {
      await User.findByIdAndUpdate(learner._id, { isDiscussionBanned: true });

      await expect(
        discussionService.editPost(postDoc._id, learner._id, learner.role, 'New content')
      ).rejects.toThrow('You are banned from participating in discussions');
    });

    it('should throw 403 ACCESS_DENIED if non-author attempts to edit post', async () => {
      await expect(
        discussionService.editPost(postDoc._id, tutor._id, tutor.role, 'Tutor overwrite')
      ).rejects.toThrow('Not authorized to edit this post');
    });

    it('should throw 403 POST_REMOVED if post was removed by moderator', async () => {
      await DiscussionPost.findByIdAndUpdate(postDoc._id, { isRemoved: true });

      await expect(
        discussionService.editPost(postDoc._id, learner._id, learner.role, 'New content')
      ).rejects.toThrow('Cannot edit a post that has been removed by a moderator');
    });
  });

  // ======================================================
  // 5. PIN / UNPIN POST
  // ======================================================
  describe('togglePinPost', () => {
    let postDoc;

    beforeEach(async () => {
      postDoc = await DiscussionPost.create({
        courseId: course._id,
        lessonId: lesson._id,
        authorId: learner._id,
        content: 'Important topic'
      });
    });

    it('should allow course tutor or admin to pin and unpin top-level post', async () => {
      const pinned = await discussionService.togglePinPost(postDoc._id, tutor._id, tutor.role, true);
      expect(pinned.isPinned).toBe(true);

      const unpinned = await discussionService.togglePinPost(postDoc._id, tutor._id, tutor.role, false);
      expect(unpinned.isPinned).toBe(false);
    });

    it('should throw 400 PIN_ON_REPLY_NOT_ALLOWED when attempting to pin a reply', async () => {
      const reply = await DiscussionPost.create({
        courseId: course._id,
        lessonId: lesson._id,
        parentId: postDoc._id,
        authorId: tutor._id,
        content: 'A reply'
      });

      await expect(
        discussionService.togglePinPost(reply._id, tutor._id, tutor.role, true)
      ).rejects.toThrow('Only top-level posts can be pinned');
    });

    it('should throw 403 ACCESS_DENIED if unauthorized user attempts to pin', async () => {
      await expect(
        discussionService.togglePinPost(postDoc._id, learner._id, learner.role, true)
      ).rejects.toThrow('Only the course tutor or an admin can pin posts');
    });
  });

  // ======================================================
  // 6. MARK OFFICIAL ANSWER
  // ======================================================
  describe('markOfficialAnswer', () => {
    let parentPost;
    let replyPost;

    beforeEach(async () => {
      parentPost = await DiscussionPost.create({
        courseId: course._id,
        lessonId: lesson._id,
        authorId: learner._id,
        content: 'How to handle errors?'
      });

      replyPost = await DiscussionPost.create({
        courseId: course._id,
        lessonId: lesson._id,
        parentId: parentPost._id,
        authorId: tutor._id,
        content: 'Use try/catch or async handlers.'
      });
    });

    it('should allow tutor to mark and unmark official answer reply', async () => {
      const marked = await discussionService.markOfficialAnswer(
        parentPost._id,
        replyPost._id,
        tutor._id,
        tutor.role
      );
      expect(marked.officialAnswerId.toString()).toBe(replyPost._id.toString());

      const unmarked = await discussionService.markOfficialAnswer(
        parentPost._id,
        null,
        tutor._id,
        tutor.role
      );
      expect(unmarked.officialAnswerId).toBeNull();
    });

    it('should throw 403 ACCESS_DENIED for unauthorized user', async () => {
      await expect(
        discussionService.markOfficialAnswer(parentPost._id, replyPost._id, learner._id, learner.role)
      ).rejects.toThrow('Only the course tutor or an admin can mark official answers');
    });

    it('should throw 404 REPLY_NOT_FOUND if reply does not exist or belong to parent', async () => {
      const otherParent = await DiscussionPost.create({
        courseId: course._id,
        lessonId: lesson._id,
        authorId: learner._id,
        content: 'Another question'
      });

      await expect(
        discussionService.markOfficialAnswer(otherParent._id, replyPost._id, tutor._id, tutor.role)
      ).rejects.toThrow('Reply not found or does not belong to this post');
    });
  });

  // ======================================================
  // 7. DELETE POST
  // ======================================================
  describe('deletePost', () => {
    let postDoc;

    beforeEach(async () => {
      postDoc = await DiscussionPost.create({
        courseId: course._id,
        lessonId: lesson._id,
        authorId: learner._id,
        content: 'Post to delete'
      });
    });

    it('should soft delete post when deleted by author', async () => {
      const deleted = await discussionService.deletePost(postDoc._id, learner._id, learner.role);
      expect(deleted.deletedAt).toBeDefined();
      expect(deleted.isRemoved).toBe(false);
    });

    it('should mark post as moderator removed when deleted by tutor or admin', async () => {
      const removed = await discussionService.deletePost(postDoc._id, tutor._id, tutor.role);
      expect(removed.isRemoved).toBe(true);
      expect(removed.removalReason).toBe('Inappropriate content');
      expect(removed.removedBy.toString()).toBe(tutor._id.toString());
    });

    it('should clear parent officialAnswerId if deleted reply was the official answer', async () => {
      const reply = await DiscussionPost.create({
        courseId: course._id,
        lessonId: lesson._id,
        parentId: postDoc._id,
        authorId: tutor._id,
        content: 'Official answer'
      });
      await DiscussionPost.findByIdAndUpdate(postDoc._id, { officialAnswerId: reply._id });

      await discussionService.deletePost(reply._id, tutor._id, tutor.role);

      const parentDb = await DiscussionPost.findById(postDoc._id);
      expect(parentDb.officialAnswerId).toBeNull();
    });

    it('should throw 403 ACCESS_DENIED for non-author non-tutor non-admin user', async () => {
      await expect(
        discussionService.deletePost(postDoc._id, nonEnrolledLearner._id, nonEnrolledLearner.role)
      ).rejects.toThrow('Not authorized to delete this post');
    });
  });

  // ======================================================
  // 8. REPORT POST & ADMIN MODERATION QUEUE
  // ======================================================
  describe('reportPost & Moderation Queue', () => {
    let postDoc;

    beforeEach(async () => {
      postDoc = await DiscussionPost.create({
        courseId: course._id,
        lessonId: lesson._id,
        authorId: tutor._id,
        content: 'Spam post content'
      });
    });

    it('should add report and alert course tutor and admins on first report', async () => {
      const reported = await discussionService.reportPost(postDoc._id, learner._id, 'Spam content');

      expect(reported.isReported).toBe(true);
      expect(reported.reports).toHaveLength(1);
      expect(reported.reports[0].reason).toBe('Spam content');

      expect(notificationService.createNotification).toHaveBeenCalled();
      expect(emailService.sendReportAlertEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: tutor.email,
          reason: 'Spam content'
        })
      );
    });

    it('should ignore duplicate reports from the same reporter idempotently', async () => {
      await discussionService.reportPost(postDoc._id, learner._id, 'Spam content');
      const secondCall = await discussionService.reportPost(postDoc._id, learner._id, 'Duplicate report');

      expect(secondCall.reports).toHaveLength(1);
    });

    it('should throw 400 CANNOT_REPORT_OWN_POST if author reports own post', async () => {
      await expect(
        discussionService.reportPost(postDoc._id, tutor._id, 'Self report')
      ).rejects.toThrow('You cannot report your own post');
    });

    it('should fetch reported posts for admin queue via getReportedPostsAdmin', async () => {
      await discussionService.reportPost(postDoc._id, learner._id, 'Inappropriate');

      const adminQueue = await discussionService.getReportedPostsAdmin({ page: 1, limit: 10 });
      expect(adminQueue.posts).toHaveLength(1);
      expect(adminQueue.posts[0]._id.toString()).toBe(postDoc._id.toString());
      expect(adminQueue.posts[0].reports[0].reason).toBe('Inappropriate');
    });

    it('should allow admin to remove post with reason via adminRemovePost', async () => {
      const removed = await discussionService.adminRemovePost(postDoc._id, admin._id, 'Confirmed violations');
      expect(removed.isRemoved).toBe(true);
      expect(removed.removalReason).toBe('Confirmed violations');
      expect(removed.isReported).toBe(false);
      expect(removed.reports).toHaveLength(0);
    });

    it('should allow admin to dismiss reports via dismissReports', async () => {
      await discussionService.reportPost(postDoc._id, learner._id, 'False flag');

      const dismissed = await discussionService.dismissReports(postDoc._id, admin._id);
      expect(dismissed.isReported).toBe(false);
      expect(dismissed.reports).toHaveLength(0);
    });

    it('should throw 400 POST_ALREADY_REMOVED when dismissing reports on removed post', async () => {
      await discussionService.adminRemovePost(postDoc._id, admin._id, 'Removed');

      await expect(
        discussionService.dismissReports(postDoc._id, admin._id)
      ).rejects.toThrow('Cannot dismiss reports on a post that has already been removed');
    });
  });

  // ======================================================
  // 9. ADMIN USER WARNINGS & BANS
  // ======================================================
  describe('adminWarnUser & adminBanUser', () => {
    it('should issue warning to user, store snippet, and send notification', async () => {
      const updatedUser = await discussionService.adminWarnUser(
        learner._id,
        admin._id,
        'Inappropriate language',
        'Long offending content snippet that goes beyond eighty characters to trigger string truncation'
      );

      expect(updatedUser.discussionWarnings).toHaveLength(1);
      expect(updatedUser.discussionWarnings[0].reason).toBe('Inappropriate language');
      expect(updatedUser.discussionWarnings[0].postContentSnippet).toContain('Long offending content');

      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: learner._id.toString(),
          title: 'Discussion Warning Issued'
        })
      );
    });

    it('should ban and unban user from discussions', async () => {
      const banned = await discussionService.adminBanUser(learner._id, true);
      expect(banned.isDiscussionBanned).toBe(true);

      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: learner._id.toString(),
          title: 'Discussion Privileges Suspended'
        })
      );

      const unbanned = await discussionService.adminBanUser(learner._id, false);
      expect(unbanned.isDiscussionBanned).toBe(false);
    });

    it('should throw 404 USER_NOT_FOUND for non-existent target user', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await expect(
        discussionService.adminWarnUser(fakeId, admin._id, 'Reason')
      ).rejects.toThrow('User not found');
      await expect(
        discussionService.adminBanUser(fakeId, true)
      ).rejects.toThrow('User not found');
    });
  });

  // ======================================================
  // 10. UNBAN REQUESTS & APPEALS
  // ======================================================
  describe('Unban Requests & Appeals', () => {
    beforeEach(async () => {
      await User.findByIdAndUpdate(learner._id, { isDiscussionBanned: true });
    });

    it('should create and retrieve unban request status for banned user', async () => {
      const reqDoc = await discussionService.createUnbanRequest({
        userId: learner._id,
        apology: 'I sincerely apologize for my posts and will follow guidelines.'
      });

      expect(reqDoc.status).toBe('pending');
      expect(reqDoc.apology).toContain('sincerely apologize');

      const myStatus = await discussionService.getMyUnbanRequestStatus(learner._id);
      expect(myStatus.apology).toBe(reqDoc.apology);
    });

    it('should throw 400 NOT_BANNED if unbanned user tries to request unban', async () => {
      await expect(
        discussionService.createUnbanRequest({
          userId: nonEnrolledLearner._id,
          apology: 'I am not banned.'
        })
      ).rejects.toThrow('User is not currently banned from discussions');
    });

    it('should throw validation errors for missing or overly long apology', async () => {
      await expect(
        discussionService.createUnbanRequest({ userId: learner._id, apology: '' })
      ).rejects.toThrow('Apology message is required');

      await expect(
        discussionService.createUnbanRequest({ userId: learner._id, apology: 'a'.repeat(1001) })
      ).rejects.toThrow('Apology exceeds 1000 characters limit');
    });

    it('should list pending unban requests for admin queue', async () => {
      await discussionService.createUnbanRequest({
        userId: learner._id,
        apology: 'Valid apology'
      });

      const queue = await discussionService.getUnbanRequestsAdmin({ page: 1, limit: 10 });
      expect(queue.requests).toHaveLength(1);
      expect(queue.requests[0].user.id).toBe(learner._id.toString());
    });

    it('should allow admin to approve unban request and unban user', async () => {
      const reqDoc = await discussionService.createUnbanRequest({
        userId: learner._id,
        apology: 'Apology for unban'
      });

      const resolved = await discussionService.resolveUnbanRequestAdmin({
        requestId: reqDoc._id,
        adminId: admin._id,
        status: 'approved',
        adminNotes: 'Apology accepted.'
      });

      expect(resolved.status).toBe('approved');

      const dbUser = await User.findById(learner._id);
      expect(dbUser.isDiscussionBanned).toBe(false);

      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: learner._id.toString(),
          title: 'Discussion Privileges Restored'
        })
      );
    });

    it('should allow admin to reject unban request', async () => {
      const reqDoc = await discussionService.createUnbanRequest({
        userId: learner._id,
        apology: 'Apology for unban'
      });

      const resolved = await discussionService.resolveUnbanRequestAdmin({
        requestId: reqDoc._id,
        adminId: admin._id,
        status: 'rejected',
        adminNotes: 'Insufficient apology.'
      });

      expect(resolved.status).toBe('rejected');

      const dbUser = await User.findById(learner._id);
      expect(dbUser.isDiscussionBanned).toBe(true);

      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: learner._id.toString(),
          title: 'Unban Request Rejected'
        })
      );
    });

    it('should throw 400 ALREADY_RESOLVED if resolving an already resolved request', async () => {
      const reqDoc = await discussionService.createUnbanRequest({
        userId: learner._id,
        apology: 'Apology'
      });

      await discussionService.resolveUnbanRequestAdmin({
        requestId: reqDoc._id,
        adminId: admin._id,
        status: 'approved'
      });

      await expect(
        discussionService.resolveUnbanRequestAdmin({
          requestId: reqDoc._id,
          adminId: admin._id,
          status: 'rejected'
        })
      ).rejects.toThrow('This request has already been resolved');
    });
  });
});
