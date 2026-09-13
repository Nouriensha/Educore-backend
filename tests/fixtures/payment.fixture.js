const mongoose = require('mongoose');

const buildPayment = (userId, courseId, overrides = {}) => {
  const uniqueId = Date.now();
  return {
    _id: new mongoose.Types.ObjectId(),
    userId: userId || new mongoose.Types.ObjectId(),
    courseId: courseId || new mongoose.Types.ObjectId(),
    amount: 49.99,
    currency: 'INR',
    razorpayOrderId: `order_${uniqueId}`,
    razorpayPaymentId: `pay_${uniqueId}`,
    razorpaySignature: `sig_${uniqueId}`,
    status: 'completed',
    paymentMethod: 'card',
    ...overrides
  };
};

module.exports = {
  buildPayment
};
