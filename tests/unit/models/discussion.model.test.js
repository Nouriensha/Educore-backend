const mongoose = require('mongoose');
const DiscussionPost = require('../../../src/models/discussionPost.model');
const DiscussionUnbanRequest = require('../../../src/models/discussionUnbanRequest.model');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');

describe('Discussion Related Models Unit Tests', () => {
  beforeAll(async () => {
    await connectDB();
    await DiscussionPost.init();
    await DiscussionUnbanRequest.init();
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  describe('DiscussionPost Model', () => {
    test('should save valid discussion post and format toJSON', async () => {
      const post = new DiscussionPost({
        courseId: new mongoose.Types.ObjectId(),
        lessonId: new mongoose.Types.ObjectId(),
        authorId: new mongoose.Types.ObjectId(),
        content: 'How does asynchronous execution work in Node.js event loop?'
      });
      const saved = await post.save();

      expect(saved._id).toBeDefined();
      expect(saved.isPinned).toBe(false);
      expect(saved.upvoteCount).toBe(0);

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });

    test('should fail validation when content exceeds 1000 characters', async () => {
      const post = new DiscussionPost({
        courseId: new mongoose.Types.ObjectId(),
        lessonId: new mongoose.Types.ObjectId(),
        authorId: new mongoose.Types.ObjectId(),
        content: 'a'.repeat(1001)
      });
      let err;
      try {
        await post.save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.errors.content).toBeDefined();
    });

    test('should validate nested image subdocument mimeType enum', async () => {
      const post = new DiscussionPost({
        courseId: new mongoose.Types.ObjectId(),
        lessonId: new mongoose.Types.ObjectId(),
        authorId: new mongoose.Types.ObjectId(),
        content: 'Check out this snippet',
        image: {
          fileUrl: 'https://example.com/image.bmp',
          publicId: 'img_123',
          mimeType: 'image/bmp', // Invalid enum
          size: 1024
        }
      });
      let err;
      try {
        await post.save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.errors['image.mimeType']).toBeDefined();
    });
  });

  describe('DiscussionUnbanRequest Model', () => {
    test('should save unban request and format toJSON', async () => {
      const reqDoc = new DiscussionUnbanRequest({
        userId: new mongoose.Types.ObjectId(),
        apology: 'I apologize for violating the discussion guidelines and promise to follow them.'
      });
      const saved = await reqDoc.save();

      expect(saved.status).toBe('pending');
      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });

    test('should enforce unique request per userId', async () => {
      const userId = new mongoose.Types.ObjectId();
      await new DiscussionUnbanRequest({
        userId,
        apology: 'First apology'
      }).save();

      let err;
      try {
        await new DiscussionUnbanRequest({
          userId,
          apology: 'Second apology'
        }).save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.code).toBe(11000);
    });
  });
});
