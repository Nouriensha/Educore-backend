const User = require('../../../src/models/user.model');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { buildUser } = require('../../fixtures/user.fixture');

describe('User Model Schema & Validation Unit Tests', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  test('should successfully create & save a valid learner user', async () => {
    const userData = buildUser({ name: 'John Doe', email: 'john@example.com' });
    const user = new User(userData);
    const savedUser = await user.save();

    expect(savedUser._id).toBeDefined();
    expect(savedUser.name).toBe('John Doe');
    expect(savedUser.email).toBe('john@example.com');
    expect(savedUser.role).toBe('learner');
    expect(savedUser.status).toBe('active');
    expect(savedUser.emailVerified).toBe(true);
  });

  test('should throw validation error when required fields are missing', async () => {
    const invalidUser = new User({});
    let err;
    try {
      await invalidUser.save();
    } catch (error) {
      err = error;
    }
    expect(err).toBeDefined();
    expect(err.errors.name).toBeDefined();
    expect(err.errors.email).toBeDefined();
    expect(err.errors.role).toBeDefined();
  });

  test('should enforce unique email constraint on non-deleted users', async () => {
    await User.createIndexes();

    const userData1 = buildUser({ email: 'duplicate@example.com' });
    const userData2 = buildUser({ email: 'duplicate@example.com' });

    await new User(userData1).save();
    let err;
    try {
      await new User(userData2).save();
    } catch (error) {
      err = error;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe(11000); // Duplicate key error code in MongoDB
  });

  test('should sanitize user object when transformed to JSON (remove passwordHash)', async () => {
    const userData = buildUser({ email: 'sanitized@example.com' });
    const user = await new User(userData).save();
    const json = user.toJSON();

    expect(json.passwordHash).toBeUndefined();
    expect(json.id).toBeDefined();
  });
});
