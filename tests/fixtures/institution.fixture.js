const mongoose = require('mongoose');

const buildInstitution = (overrides = {}) => {
  const uniqueId = Date.now() + Math.floor(Math.random() * 1000);
  return {
    _id: new mongoose.Types.ObjectId(),
    name: `Test Institution ${uniqueId}`,
    slug: `test-institution-${uniqueId}`,
    email: `inst_${uniqueId}@example.com`,
    phone: '+1234567890',
    owner: new mongoose.Types.ObjectId(),
    status: 'active',
    isApproved: true,
    address: {
      street: '123 Tech Blvd',
      city: 'Innovate City',
      state: 'Tech State',
      country: 'USA',
      zipCode: '10001'
    },
    ...overrides
  };
};

module.exports = {
  buildInstitution
};
