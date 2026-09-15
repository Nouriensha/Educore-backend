const Joi = require('joi');
const validate = require('../../../src/middlewares/validate.middleware');
const { ApiError } = require('../../../src/utils/errors');

describe('Validate Middleware Unit Tests', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      body: {},
      params: {},
      query: {}
    };
    res = {};
    next = jest.fn();
  });

  test('should validate req.body, strip unknown fields, and call next()', () => {
    const schemaMap = {
      body: Joi.object({
        name: Joi.string().required(),
        age: Joi.number().optional()
      })
    };

    req.body = { name: 'Alice', age: 25, extraField: 'should be stripped' };

    const middleware = validate(schemaMap);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ name: 'Alice', age: 25 });
  });

  test('should validate multiple request segments (params & body)', () => {
    const schemaMap = {
      params: Joi.object({
        id: Joi.string().hex().length(24).required()
      }),
      body: Joi.object({
        title: Joi.string().required()
      })
    };

    req.params = { id: '507f1f77bcf86cd799439011' };
    req.body = { title: 'Test Title' };

    const middleware = validate(schemaMap);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  test('should pass ApiError 400 with VALIDATION_ERROR details to next() when validation fails', () => {
    const schemaMap = {
      body: Joi.object({
        email: Joi.string().email().required(),
        password: Joi.string().min(6).required()
      })
    };

    req.body = { email: 'invalid-email', password: '123' };

    const middleware = validate(schemaMap);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toHaveLength(2);
    expect(err.details[0].field).toBe('email');
    expect(err.details[1].field).toBe('password');
  });
});
