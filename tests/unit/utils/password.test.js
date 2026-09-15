const { hashPassword, comparePassword } = require('../../../src/utils/password');

describe('Password Utility Unit Tests', () => {
  test('should correctly hash password and verify valid password', async () => {
    const rawPassword = 'SecurePassword123!';
    const hash = await hashPassword(rawPassword);

    expect(hash).toBeDefined();
    expect(hash).not.toBe(rawPassword);
    expect(hash.startsWith('$2')).toBe(true);

    const isMatch = await comparePassword(rawPassword, hash);
    expect(isMatch).toBe(true);
  });

  test('should return false for invalid password comparison', async () => {
    const rawPassword = 'SecurePassword123!';
    const wrongPassword = 'WrongPassword999!';
    const hash = await hashPassword(rawPassword);

    const isMatch = await comparePassword(wrongPassword, hash);
    expect(isMatch).toBe(false);
  });
});
