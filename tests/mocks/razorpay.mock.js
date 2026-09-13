const mockRazorpayInstance = {
  orders: {
    create: jest.fn().mockImplementation((options) => Promise.resolve({
      id: `order_mock_${Date.now()}`,
      entity: 'order',
      amount: options.amount,
      currency: options.currency || 'INR',
      receipt: options.receipt,
      status: 'created'
    })),
    fetch: jest.fn().mockImplementation((orderId) => Promise.resolve({
      id: orderId,
      entity: 'order',
      status: 'paid'
    }))
  },
  payments: {
    fetch: jest.fn().mockImplementation((paymentId) => Promise.resolve({
      id: paymentId,
      entity: 'payment',
      status: 'captured',
      amount: 4999,
      currency: 'INR'
    })),
    refund: jest.fn().mockImplementation((paymentId, options) => Promise.resolve({
      id: `rfnd_mock_${Date.now()}`,
      entity: 'refund',
      payment_id: paymentId,
      amount: options?.amount || 4999,
      status: 'processed'
    }))
  }
};

module.exports = {
  mockRazorpayInstance
};
