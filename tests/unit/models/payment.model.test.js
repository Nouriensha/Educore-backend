const mongoose = require('mongoose');
const Payment = require('../../../src/models/payment.model');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');

describe('Payment Model Unit Tests', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  test('should successfully create & save valid payment', async () => {
    const data = {
      learnerId: new mongoose.Types.ObjectId(),
      courseId: new mongoose.Types.ObjectId(),
      amount: 1999,
      currency: 'INR',
      transactionId: `tx_${Date.now()}`,
      orderId: `order_${Date.now()}`,
      paymentStatus: 'success',
      paidAt: new Date()
    };

    const payment = new Payment(data);
    const saved = await payment.save();

    expect(saved._id).toBeDefined();
    expect(saved.paymentStatus).toBe('success');
    expect(saved.gateway).toBe('razorpay');
  });

  test('should fail validation when learnerId, amount, or transactionId are missing', async () => {
    const payment = new Payment({});
    let err;
    try {
      await payment.save();
    } catch (error) {
      err = error;
    }

    expect(err).toBeDefined();
    expect(err.errors.learnerId).toBeDefined();
    expect(err.errors.amount).toBeDefined();
    expect(err.errors.transactionId).toBeDefined();
  });

  test('should reject negative amount values', async () => {
    const payment = new Payment({
      learnerId: new mongoose.Types.ObjectId(),
      transactionId: `tx_neg_${Date.now()}`,
      amount: -100
    });

    let err;
    try {
      await payment.save();
    } catch (error) {
      err = error;
    }

    expect(err).toBeDefined();
    expect(err.errors.amount).toBeDefined();
  });
});
