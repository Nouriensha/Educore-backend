const { requireRoles } = require('../../../src/middlewares/rbac.middleware');
const { ApiError } = require('../../../src/utils/errors');
const { ROLES } = require('../../../src/utils/roles');

describe('RBAC Middleware Unit Tests', () => {
  let req, res, next;

  beforeEach(() => {
    req = {};
    res = {};
    next = jest.fn();
  });

  test('should return 401 AUTH_REQUIRED if req.user is missing', () => {
    const middleware = requireRoles(ROLES.TUTOR, ROLES.INSTITUTION_ADMIN);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('AUTH_REQUIRED');
  });

  test('should return 403 INSUFFICIENT_PERMISSIONS if user role is not allowed', () => {
    req.user = { role: ROLES.LEARNER };
    const middleware = requireRoles(ROLES.TUTOR, ROLES.INSTITUTION_ADMIN);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  test('should call next() with no errors if user has exact allowed role', () => {
    req.user = { role: ROLES.TUTOR };
    const middleware = requireRoles(ROLES.TUTOR);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  test('should handle role aliases cleanly (e.g. platform_admin alias allows super_admin and platform_owner)', () => {
    const middleware = requireRoles('platform_admin');

    req.user = { role: ROLES.SUPER_ADMIN };
    middleware(req, res, next);
    expect(next).toHaveBeenLastCalledWith();

    req.user = { role: ROLES.PLATFORM_OWNER };
    middleware(req, res, next);
    expect(next).toHaveBeenLastCalledWith();
  });

  test('should handle admin role alias (allows legacy admin and institution_admin)', () => {
    const middleware = requireRoles('admin');

    req.user = { role: ROLES.INSTITUTION_ADMIN };
    middleware(req, res, next);
    expect(next).toHaveBeenLastCalledWith();

    req.user = { role: ROLES.LEGACY_ADMIN };
    middleware(req, res, next);
    expect(next).toHaveBeenLastCalledWith();
  });
});
