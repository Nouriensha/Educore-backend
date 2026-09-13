const mockEmailService = {
  sendMail: jest.fn().mockResolvedValue({ messageId: 'mock-email-id-123' }),
  sendTutorApprovalRequestEmail: jest.fn().mockResolvedValue(true),
  sendCertificateEmail: jest.fn().mockResolvedValue(true),
  sendWelcomeEmail: jest.fn().mockResolvedValue(true),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true)
};

module.exports = {
  mockEmailService
};
