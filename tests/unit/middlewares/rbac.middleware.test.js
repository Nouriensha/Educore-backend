const { requireRoles } = require('../../../src/middlewares/rbac.middleware');
const { ApiError } = require('../../../src/utils/errors');

describe('RBAC Middleware Unit Tests', () => {
  let req, res, next;

  beforeEach(() => {
    req = {};
    res = {};
    next = jest.fn();
  });

  test('should return 401 AUTH_REQUIRED if req.user is missing', () => {
    const middleware = requireRoles('admin', 'tutor');
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('AUTH_REQUIRED');
  });

  test('should return 403 INSUFFICIENT_PERMISSIONS if user role is not allowed', () => {
    req.user = { role: 'learner' };
    const middleware = requireRoles('admin', 'tutor');
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  test('should call next() with no errors if user has an allowed role', () => {
    req.user = { role: 'tutor' };
    const middleware = requireRoles('tutor', 'admin');
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });
});
