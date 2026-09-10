const request = require('supertest');
const app = require('../../src/app');
const Course = require('../../src/models/course.model');
const User = require('../../src/models/user.model');
const { createAccessToken } = require('../../src/utils/tokens');
const { connectDB, closeDB, clearDB } = require('../setup/test-db');
const { buildUser, buildCourse } = require('../fixtures/user.fixture');

describe('Course API Routes Integration & Role-Based Access Tests', () => {
  let tutorUser, learnerUser, adminUser;
  let tutorToken, learnerToken, adminToken;

  beforeAll(async () => {
    await connectDB();
  });

  beforeEach(async () => {
    tutorUser = await new User(buildUser({ role: 'tutor', accountType: 'individual_tutor', email: 'tutor@example.com', status: 'active', emailVerified: true })).save();
    learnerUser = await new User(buildUser({ role: 'learner', accountType: 'individual_learner', email: 'learner@example.com', status: 'active', emailVerified: true })).save();
    adminUser = await new User(buildUser({ role: 'super_admin', accountType: 'platform_admin', email: 'admin@example.com', status: 'active', emailVerified: true })).save();

    tutorToken = createAccessToken(tutorUser);
    learnerToken = createAccessToken(learnerUser);
    adminToken = createAccessToken(adminUser);
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  describe('GET /api/v1/courses/catalogue', () => {
    test('should allow public access to list published courses in catalogue', async () => {
      await new Course(buildCourse(tutorUser._id, { status: 'published', visibility: 'public' })).save();

      const res = await request(app).get('/api/v1/courses/catalogue');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.courses).toBeDefined();
    });
  });

  describe('POST /api/v1/courses (Create Course RBAC)', () => {
    test('should allow tutors to create a course', async () => {
      const payload = {
        title: 'New React Testing Masterclass',
        description: 'Comprehensive testing for React apps.',
        category: 'Development',
        level: 'Intermediate',
        price: 29.99
      };

      const res = await request(app)
        .post('/api/v1/courses')
        .set('Authorization', `Bearer ${tutorToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe('New React Testing Masterclass');
    });

    test('should reject learners from creating a course (403 Forbidden)', async () => {
      const payload = {
        title: 'Unauthorized Course',
        description: 'Learner trying to act as tutor.',
        category: 'Development'
      };

      const res = await request(app)
        .post('/api/v1/courses')
        .set('Authorization', `Bearer ${learnerToken}`)
        .send(payload);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    test('should reject unauthenticated requests (401 Unauthorized)', async () => {
      const res = await request(app)
        .post('/api/v1/courses')
        .send({ title: 'No Auth' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });
});
