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

  test('errorHandler should normalize Mongoose ValidationError', () => {
    const validationErr = { name: 'ValidationError', errors: { title: { message: 'Title is required' } } };
    errorHandler(validationErr, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: 'MONGOOSE_VALIDATION_ERROR'
      })
    );
  });

  test('errorHandler should normalize Mongoose CastError (invalid ObjectId)', () => {
    const castErr = { name: 'CastError', path: '_id', value: 'invalid_id' };
    errorHandler(castErr, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: 'INVALID_ID'
      })
    );
  });

  test('errorHandler should normalize MulterError and body entity.too.large error', () => {
    const multerErr = { name: 'MulterError', message: 'File too large' };
    errorHandler(multerErr, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: 'UPLOAD_ERROR',
        message: 'File too large'
      })
    );

    res.status.mockClear();
    res.json.mockClear();

    const bodyTooLargeErr = { type: 'entity.too.large' };
    errorHandler(bodyTooLargeErr, req, res, next);

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: 'BODY_TOO_LARGE'
      })
    );
  });
});

