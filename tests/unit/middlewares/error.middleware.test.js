const { errorHandler, notFoundHandler } = require('../../../src/middlewares/error.middleware');
const { ApiError } = require('../../../src/utils/errors');

describe('Error Middleware Unit Tests', () => {
  let req, res, next;

  beforeEach(() => {
    req = { method: 'GET', originalUrl: '/api/v1/nonexistent' };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    next = jest.fn();
  });

  test('notFoundHandler should pass a 404 ApiError to next()', () => {
    notFoundHandler(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('ROUTE_NOT_FOUND');
  });

  test('errorHandler should handle custom ApiError correctly', () => {
    const apiError = new ApiError(403, 'Forbidden action', 'FORBIDDEN');
    errorHandler(apiError, req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'Forbidden action',
        code: 'FORBIDDEN'
      })
    );
  });

  test('errorHandler should normalize Mongoose duplicate key error (11000)', () => {
    const mongoErr = { code: 11000, message: 'E11000 duplicate key error' };
    errorHandler(mongoErr, req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: 'DUPLICATE_RESOURCE'
      })
    );
  });
});
