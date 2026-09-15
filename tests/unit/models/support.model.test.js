const mongoose = require('mongoose');
const Ticket = require('../../../src/models/ticket.model');
const TicketMessage = require('../../../src/models/ticketMessage.model');
const TicketAuditLog = require('../../../src/models/ticketAuditLog.model');
const AuditLog = require('../../../src/models/auditLog.model');
const EmailLog = require('../../../src/models/emailLog.model');
const Notification = require('../../../src/models/notification.model');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');

describe('Support & Logging Models Unit Tests', () => {
  beforeAll(async () => {
    await connectDB();
    await Ticket.init();
    await TicketMessage.init();
    await TicketAuditLog.init();
    await AuditLog.init();
    await EmailLog.init();
    await Notification.init();
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  describe('Ticket Model', () => {
    test('should save valid ticket and format toJSON', async () => {
      const ticket = new Ticket({
        ticketId: 'TCK-1001',
        subject: 'Cannot access live class',
        issueType: 'technical',
        description: 'Encountered 403 error when clicking meeting link',
        creatorId: new mongoose.Types.ObjectId(),
        creatorRole: 'learner',
        category: 'Live Classroom',
        scope: 'institution'
      });
      const saved = await ticket.save();

      expect(saved.status).toBe('open');
      expect(saved.priority).toBe('medium');

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });

    test('should enforce unique ticketId', async () => {
      const creatorId = new mongoose.Types.ObjectId();

      await new Ticket({
        ticketId: 'DUP-TCK',
        subject: 'First ticket',
        issueType: 'billing',
        description: 'Desc 1',
        creatorId,
        creatorRole: 'learner',
        category: 'Billing'
      }).save();

      let err;
      try {
        await new Ticket({
          ticketId: 'DUP-TCK',
          subject: 'Second ticket',
          issueType: 'billing',
          description: 'Desc 2',
          creatorId,
          creatorRole: 'learner',
          category: 'Billing'
        }).save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.code).toBe(11000);
    });

    test('should reject invalid ticket priority enum', async () => {
      const ticket = new Ticket({
        ticketId: 'TCK-ERR',
        subject: 'Sub',
        issueType: 'billing',
        description: 'Desc',
        creatorId: new mongoose.Types.ObjectId(),
        creatorRole: 'learner',
        category: 'Billing',
        priority: 'ultra_high'
      });
      let err;
      try {
        await ticket.save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeDefined();
      expect(err.errors.priority).toBeDefined();
    });
  });

  describe('TicketMessage Model', () => {
    test('should save ticket message and format toJSON', async () => {
      const ticketId = new mongoose.Types.ObjectId();
      const msg = new TicketMessage({
        ticketId,
        senderId: new mongoose.Types.ObjectId(),
        senderRole: 'tutor',
        message: 'We are investigating your issue now.'
      });
      const saved = await msg.save();

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });
  });

  describe('TicketAuditLog Model', () => {
    test('should validate action enum and transform toJSON', async () => {
      const log = new TicketAuditLog({
        ticketId: new mongoose.Types.ObjectId(),
        actorUserId: new mongoose.Types.ObjectId(),
        actorRole: 'institution_admin',
        action: 'TICKET_ASSIGNED'
      });
      const saved = await log.save();

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();
    });
  });

  describe('AuditLog Model', () => {
    test('should save audit log with allowed action', async () => {
      const log = new AuditLog({
        actorUserId: new mongoose.Types.ObjectId(),
        targetUserId: new mongoose.Types.ObjectId(),
        action: 'BAN_USER'
      });
      const saved = await log.save();

      expect(saved.action).toBe('BAN_USER');
      expect(saved.createdAt).toBeDefined();
      expect(saved.updatedAt).toBeUndefined(); // Configured with updatedAt: false
    });
  });

  describe('EmailLog Model', () => {
    test('should save email log with status enum', async () => {
      const log = new EmailLog({
        recipient: 'user@example.com',
        subject: 'Welcome to Educore',
        status: 'sent'
      });
      const saved = await log.save();

      expect(saved.recipient).toBe('user@example.com');
      expect(saved.status).toBe('sent');
    });
  });

  describe('Notification Model', () => {
    test('should save notification and handle transformFn for both toJSON and toObject', async () => {
      const notif = new Notification({
        userId: new mongoose.Types.ObjectId(),
        title: 'New Grade Available',
        message: 'Your assignment #1 has been graded.',
        type: 'grade'
      });
      const saved = await notif.save();

      expect(saved.isRead).toBe(false);

      const json = saved.toJSON();
      expect(json.id).toBeDefined();
      expect(json._id).toBeUndefined();

      const obj = saved.toObject();
      expect(obj.id).toBeDefined();
      expect(obj._id).toBeUndefined();
    });
  });
});
