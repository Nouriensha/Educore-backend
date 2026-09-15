const mongoose = require('mongoose');
const ticketService = require('../../../src/services/ticket.service');
const Ticket = require('../../../src/models/ticket.model');
const TicketMessage = require('../../../src/models/ticketMessage.model');
const TicketAuditLog = require('../../../src/models/ticketAuditLog.model');
const User = require('../../../src/models/user.model');
const Course = require('../../../src/models/course.model');
const Institution = require('../../../src/models/institution.model');
const { ApiError } = require('../../../src/utils/errors');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');

// Mock notification and email services
jest.mock('../../../src/services/notification.service', () => ({
  createNotification: jest.fn().mockResolvedValue(true)
}));

jest.mock('../../../src/services/email.service', () => ({
  sendMail: jest.fn().mockResolvedValue(true)
}));

const { createNotification } = require('../../../src/services/notification.service');
const emailService = require('../../../src/services/email.service');

describe('Ticket Service Unit Tests', () => {
  let learnerUser, tutorUser, instAdminUser, platformAdminUser;
  let sampleInstitution, sampleCourse;

  beforeAll(async () => {
    await connectDB();
    await Ticket.init();
    await TicketMessage.init();
    await TicketAuditLog.init();
    await User.init();
    await Course.init();
    await Institution.init();
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    // Create base fixture data
    const ownerId = new mongoose.Types.ObjectId();
    sampleInstitution = await Institution.create({
      name: 'Tech University',
      domain: 'techuni.edu',
      code: 'TECHUNI01',
      email: 'contact@techuni.edu',
      owner: ownerId,
      status: 'active'
    });

    learnerUser = await User.create({
      name: 'Learner One',
      email: 'learner@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
      role: 'learner',
      status: 'active',
      institutionId: sampleInstitution._id
    });

    tutorUser = await User.create({
      name: 'Tutor One',
      email: 'tutor@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
      role: 'tutor',
      status: 'active',
      institutionId: sampleInstitution._id
    });

    instAdminUser = await User.create({
      name: 'Inst Admin',
      email: 'instadmin@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
      role: 'institution_admin',
      status: 'active',
      institutionId: sampleInstitution._id
    });

    platformAdminUser = await User.create({
      name: 'Platform Admin',
      email: 'sysadmin@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
      role: 'super_admin',
      status: 'active'
    });

    sampleCourse = await Course.create({
      title: 'Node.js Mastery',
      slug: 'nodejs-mastery',
      code: 'NODE101',
      description: 'Complete backend course',
      category: 'Web Development',
      authorId: tutorUser._id,
      institutionId: sampleInstitution._id,
      status: 'published',
      price: 0
    });
  });

  afterEach(async () => {
    await clearDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  // ==========================================
  // 1. createTicket
  // ==========================================
  describe('createTicket', () => {
    test('should throw 400 MISSING_FIELDS if subject, description, or issueType is missing', async () => {
      await expect(ticketService.createTicket({
        creator: learnerUser,
        description: 'Need help',
        issueType: 'technical'
      })).rejects.toThrow(ApiError);

      await expect(ticketService.createTicket({
        creator: learnerUser,
        subject: 'Help',
        issueType: 'technical'
      })).rejects.toThrow(ApiError);
    });

    test('should throw 403 FORBIDDEN if creator is a platform administrator', async () => {
      await expect(ticketService.createTicket({
        creator: platformAdminUser,
        subject: 'Platform system test',
        issueType: 'technical',
        description: 'Testing platform ticket creation'
      })).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN'
      });
    });

    test('should throw 400 MISSING_COURSE if learner creates academic ticket without courseId', async () => {
      await expect(ticketService.createTicket({
        creator: learnerUser,
        subject: 'Question on lecture 3',
        issueType: 'academic',
        description: 'Need clarification on async code'
      })).rejects.toMatchObject({
        statusCode: 400,
        code: 'MISSING_COURSE'
      });
    });

    test('should successfully create a technical ticket for a learner routed to platform_admin', async () => {
      const ticket = await ticketService.createTicket({
        creator: learnerUser,
        subject: 'Video playback issue',
        issueType: 'technical',
        description: 'Video keeps buffering on lesson 2',
        requestMeta: { ip: '127.0.0.1', userAgent: 'JestTest' }
      });

      expect(ticket).toBeDefined();
      expect(ticket.ticketId).toMatch(/^TK-\d{8}-\d{4}$/);
      expect(ticket.status).toBe('open');
      expect(ticket.assignedRole).toBe('platform_admin');
      expect(ticket.scope).toBe('platform');

      // Verify Audit Log persisted
      const auditLog = await TicketAuditLog.findOne({ ticketId: ticket._id });
      expect(auditLog).toBeDefined();
      expect(auditLog.action).toBe('TICKET_CREATED');

      // Verify notifications dispatched
      expect(createNotification).toHaveBeenCalled();
      expect(emailService.sendMail).toHaveBeenCalled();
    });

    test('should create an academic ticket for a learner with courseId routed to tutor', async () => {
      const ticket = await ticketService.createTicket({
        creator: learnerUser,
        subject: 'Assignment calculation question',
        issueType: 'academic',
        description: 'How to compute GPA?',
        courseId: sampleCourse._id
      });

      expect(ticket.assignedRole).toBe('tutor');
      expect(ticket.scope).toBe('institution'); // Since learner has institutionId
      expect(ticket.courseId.toString()).toBe(sampleCourse._id.toString());
    });

    test('should route account ticket for institutional learner to institution_admin', async () => {
      const ticket = await ticketService.createTicket({
        creator: learnerUser,
        subject: 'Update email address',
        issueType: 'account',
        description: 'Please change my registered institution email'
      });

      expect(ticket.assignedRole).toBe('institution_admin');
      expect(ticket.scope).toBe('institution');
    });

    test('should route tutor tickets for institution tutors to institution_admin', async () => {
      const ticket = await ticketService.createTicket({
        creator: tutorUser,
        subject: 'Classroom equipment request',
        issueType: 'technical',
        description: 'Need new webcam'
      });

      expect(ticket.assignedRole).toBe('institution_admin');
      expect(ticket.scope).toBe('institution');
    });

    test('should route institution admin tickets to platform_admin', async () => {
      const ticket = await ticketService.createTicket({
        creator: instAdminUser,
        subject: 'Billing discrepancy',
        issueType: 'billing',
        description: 'Incorrect invoice amount'
      });

      expect(ticket.assignedRole).toBe('platform_admin');
      expect(ticket.scope).toBe('platform');
    });
  });

  // ==========================================
  // 2. getTickets
  // ==========================================
  describe('getTickets', () => {
    let t1, t2, t3;

    beforeEach(async () => {
      t1 = await ticketService.createTicket({
        creator: learnerUser,
        subject: 'Learner Tech Ticket',
        issueType: 'technical',
        description: 'Issue 1'
      });

      t2 = await ticketService.createTicket({
        creator: learnerUser,
        subject: 'Learner Academic Ticket',
        issueType: 'academic',
        description: 'Issue 2',
        courseId: sampleCourse._id
      });

      t3 = await ticketService.createTicket({
        creator: tutorUser,
        subject: 'Tutor Ticket',
        issueType: 'technical',
        description: 'Issue 3'
      });
    });

    test('learner should only retrieve tickets created by themselves', async () => {
      const result = await ticketService.getTickets({ user: learnerUser });
      expect(result.tickets.length).toBe(2);
      expect(result.pagination.total).toBe(2);
      const ticketIds = result.tickets.map(t => t.id || t._id.toString());
      expect(ticketIds).toContain(t1._id.toString());
      expect(ticketIds).toContain(t2._id.toString());
    });

    test('tutor should retrieve tickets they created plus academic tickets assigned to their course', async () => {
      const result = await ticketService.getTickets({ user: tutorUser });
      expect(result.tickets.length).toBe(2); // t2 (academic for tutor's course) & t3 (tutor created)
      const ticketIds = result.tickets.map(t => t.id || t._id.toString());
      expect(ticketIds).toContain(t2._id.toString());
      expect(ticketIds).toContain(t3._id.toString());
    });

    test('institution admin should retrieve institution-assigned tickets and self-created tickets', async () => {
      const result = await ticketService.getTickets({ user: instAdminUser });
      // t3 was created by tutorUser (has instId, assignedRole: 'institution_admin')
      expect(result.tickets.length).toBeGreaterThanOrEqual(1);
    });

    test('platform admin should retrieve all tickets across system and filter by search', async () => {
      const result = await ticketService.getTickets({
        user: platformAdminUser,
        search: 'Academic'
      });
      expect(result.tickets.length).toBe(1);
      expect(result.tickets[0].subject).toBe('Learner Academic Ticket');
    });
  });

  // ==========================================
  // 3. getTicketById
  // ==========================================
  describe('getTicketById', () => {
    let ticket;

    beforeEach(async () => {
      ticket = await ticketService.createTicket({
        creator: learnerUser,
        subject: 'Access bug',
        issueType: 'technical',
        description: 'Cannot login'
      });

      await ticketService.addTicketMessage({
        ticketId: ticket._id,
        sender: platformAdminUser,
        message: 'Internal notes investigating server logs',
        isInternalNote: true
      });

      await ticketService.addTicketMessage({
        ticketId: ticket._id,
        sender: platformAdminUser,
        message: 'Hello, please clear your cache.',
        isInternalNote: false
      });
    });

    test('should throw 404 if ticket is not found', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await expect(ticketService.getTicketById(fakeId, learnerUser))
        .rejects.toMatchObject({ statusCode: 404, code: 'TICKET_NOT_FOUND' });
    });

    test('creator should get ticket but internal notes should be hidden', async () => {
      const result = await ticketService.getTicketById(ticket._id, learnerUser);
      expect(result.ticket).toBeDefined();
      expect(result.messages.length).toBe(1); // Internal note hidden
      expect(result.messages[0].message).toBe('Hello, please clear your cache.');
    });

    test('platform admin should get ticket along with internal notes', async () => {
      const result = await ticketService.getTicketById(ticket._id, platformAdminUser);
      expect(result.messages.length).toBe(2); // Includes internal note
    });

    test('unauthorized learner should be denied access (403 FORBIDDEN)', async () => {
      const otherLearner = await User.create({
        name: 'Unrelated Learner',
        email: 'other@example.com',
        passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
        role: 'learner',
        status: 'active'
      });

      await expect(ticketService.getTicketById(ticket._id, otherLearner))
        .rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    });
  });

  // ==========================================
  // 4. addTicketMessage
  // ==========================================
  describe('addTicketMessage', () => {
    let ticket;

    beforeEach(async () => {
      ticket = await ticketService.createTicket({
        creator: learnerUser,
        subject: 'Payment failed',
        issueType: 'billing',
        description: 'Card declined'
      });
    });

    test('should throw 400 if message body is empty', async () => {
      await expect(ticketService.addTicketMessage({
        ticketId: ticket._id,
        sender: platformAdminUser,
        message: '   '
      })).rejects.toMatchObject({ statusCode: 400, code: 'EMPTY_MESSAGE' });
    });

    test('should throw 403 CHAT_LOCKED if creator replies while ticket is open (before support responds)', async () => {
      await expect(ticketService.addTicketMessage({
        ticketId: ticket._id,
        sender: learnerUser,
        message: 'Any updates?'
      })).rejects.toMatchObject({ statusCode: 403, code: 'CHAT_LOCKED' });
    });

    test('support agent reply should transition ticket status to waiting_for_user', async () => {
      const msg = await ticketService.addTicketMessage({
        ticketId: ticket._id,
        sender: platformAdminUser,
        message: 'We have updated your billing info. Please try again.'
      });

      expect(msg).toBeDefined();

      const updatedTicket = await Ticket.findById(ticket._id);
      expect(updatedTicket.status).toBe('waiting_for_user');

      // Verify email dispatched to creator
      expect(emailService.sendMail).toHaveBeenCalled();
    });

    test('creator can reply when ticket status is waiting_for_user and transition status to in_progress', async () => {
      // First, support replies
      await ticketService.addTicketMessage({
        ticketId: ticket._id,
        sender: platformAdminUser,
        message: 'Need more details'
      });

      // Now creator replies
      const creatorMsg = await ticketService.addTicketMessage({
        ticketId: ticket._id,
        sender: learnerUser,
        message: 'Here are the details requested'
      });

      expect(creatorMsg).toBeDefined();

      const updatedTicket = await Ticket.findById(ticket._id);
      expect(updatedTicket.status).toBe('in_progress');
    });

    test('learner cannot write internal notes (isInternalNote becomes false)', async () => {
      // First set status to waiting_for_user so creator can post
      await ticketService.addTicketMessage({
        ticketId: ticket._id,
        sender: platformAdminUser,
        message: 'Please reply'
      });

      const creatorMsg = await ticketService.addTicketMessage({
        ticketId: ticket._id,
        sender: learnerUser,
        message: 'User note',
        isInternalNote: true
      });

      expect(creatorMsg.isInternalNote).toBe(false);
    });
  });

  // ==========================================
  // 5. updateTicketStatus
  // ==========================================
  describe('updateTicketStatus', () => {
    let ticket;

    beforeEach(async () => {
      ticket = await ticketService.createTicket({
        creator: learnerUser,
        subject: 'Bug report',
        issueType: 'technical',
        description: 'Error on page load'
      });
    });

    test('should throw 403 if support staff attempts to mark ticket as closed', async () => {
      await expect(ticketService.updateTicketStatus({
        ticketId: ticket._id,
        status: 'closed',
        user: platformAdminUser
      })).rejects.toMatchObject({ statusCode: 403, code: 'UNAUTHORIZED_STATUS_CHANGE' });
    });

    test('support staff can mark ticket as resolved', async () => {
      const updated = await ticketService.updateTicketStatus({
        ticketId: ticket._id,
        status: 'resolved',
        user: platformAdminUser
      });

      expect(updated.status).toBe('resolved');
      expect(updated.resolvedAt).toBeDefined();
      expect(updated.slaResolutionTimeMs).toBeGreaterThanOrEqual(0);
    });

    test('creator can mark resolved ticket as closed', async () => {
      // Resolve first
      await ticketService.updateTicketStatus({
        ticketId: ticket._id,
        status: 'resolved',
        user: platformAdminUser
      });

      // Creator closes
      const closed = await ticketService.updateTicketStatus({
        ticketId: ticket._id,
        status: 'closed',
        user: learnerUser
      });

      expect(closed.status).toBe('closed');
    });

    test('creator can reopen resolved ticket to in_progress within reopen window', async () => {
      await ticketService.updateTicketStatus({
        ticketId: ticket._id,
        status: 'resolved',
        user: platformAdminUser
      });

      const reopened = await ticketService.updateTicketStatus({
        ticketId: ticket._id,
        status: 'in_progress',
        user: learnerUser
      });

      expect(reopened.status).toBe('in_progress');
      expect(reopened.resolvedAt).toBeNull();
    });

    test('creator cannot reopen ticket if it is currently open (INVALID_REOPEN_STATE)', async () => {
      await expect(ticketService.updateTicketStatus({
        ticketId: ticket._id,
        status: 'in_progress',
        user: learnerUser
      })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_REOPEN_STATE' });
    });

    test('returns immediately if status is unchanged', async () => {
      const result = await ticketService.updateTicketStatus({
        ticketId: ticket._id,
        status: 'open',
        user: platformAdminUser
      });

      expect(result.status).toBe('open');
    });
  });

  // ==========================================
  // 6. assignTicket
  // ==========================================
  describe('assignTicket', () => {
    let ticket;

    beforeEach(async () => {
      ticket = await ticketService.createTicket({
        creator: learnerUser,
        subject: 'General query',
        issueType: 'other',
        description: 'Question about certificate'
      });
    });

    test('should throw 403 FORBIDDEN if non-admin attempts assignment', async () => {
      await expect(ticketService.assignTicket({
        ticketId: ticket._id,
        assigneeId: platformAdminUser._id,
        user: learnerUser
      })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    });

    test('platform admin can assign ticket to support staff and update status to assigned', async () => {
      const assigned = await ticketService.assignTicket({
        ticketId: ticket._id,
        assigneeId: platformAdminUser._id,
        user: platformAdminUser
      });

      expect(assigned.assignedTo.toString()).toBe(platformAdminUser._id.toString());
      expect(assigned.status).toBe('assigned');

      const auditLog = await TicketAuditLog.findOne({ ticketId: ticket._id, action: 'TICKET_ASSIGNED' });
      expect(auditLog).toBeDefined();
    });

    test('should throw 404 ASSIGNEE_NOT_FOUND if assignee user does not exist', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await expect(ticketService.assignTicket({
        ticketId: ticket._id,
        assigneeId: fakeId,
        user: platformAdminUser
      })).rejects.toMatchObject({ statusCode: 404, code: 'ASSIGNEE_NOT_FOUND' });
    });

    test('institution admin cannot assign ticket to user outside institution', async () => {
      const instTicket = await ticketService.createTicket({
        creator: learnerUser,
        subject: 'Account update',
        issueType: 'account',
        description: 'Help'
      });

      const outsideUser = await User.create({
        name: 'Outside User',
        email: 'outside@example.com',
        passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
        role: 'institution_admin',
        status: 'active' // No institutionId
      });

      await expect(ticketService.assignTicket({
        ticketId: instTicket._id,
        assigneeId: outsideUser._id,
        user: instAdminUser
      })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_ASSIGNEE' });
    });
  });

  // ==========================================
  // 7. escalateTicket
  // ==========================================
  describe('escalateTicket', () => {
    let instTicket;

    beforeEach(async () => {
      instTicket = await ticketService.createTicket({
        creator: learnerUser,
        subject: 'Complex institution issue',
        issueType: 'account',
        description: 'Requires higher tier escalation'
      });
      // instTicket starts with assignedRole: 'institution_admin', scope: 'institution'
    });

    test('institution admin can escalate ticket from institution_admin to platform_support', async () => {
      const escalated = await ticketService.escalateTicket({
        ticketId: instTicket._id,
        notes: 'Escalating to platform support for complex identity verification',
        user: instAdminUser
      });

      expect(escalated.assignedRole).toBe('platform_support');
      expect(escalated.scope).toBe('platform');
      expect(escalated.assignedTo).toBeNull();
      expect(escalated.status).toBe('open');

      // Check escalation note created in TicketMessage
      const msg = await TicketMessage.findOne({ ticketId: instTicket._id, isInternalNote: true });
      expect(msg).toBeDefined();
      expect(msg.message).toContain('Escalated to PLATFORM_SUPPORT');
    });

    test('platform admin can escalate ticket from platform_support to platform_admin and then development', async () => {
      // First step: inst_admin to platform_support
      await ticketService.escalateTicket({
        ticketId: instTicket._id,
        user: instAdminUser
      });

      // Second step: platform_support to platform_admin
      const step2 = await ticketService.escalateTicket({
        ticketId: instTicket._id,
        user: platformAdminUser
      });
      expect(step2.assignedRole).toBe('platform_admin');

      // Third step: platform_admin to development
      const step3 = await ticketService.escalateTicket({
        ticketId: instTicket._id,
        user: platformAdminUser
      });
      expect(step3.assignedRole).toBe('development');

      // Fourth step: max level reached -> throws 400 MAX_ESCALATION_REACHED
      await expect(ticketService.escalateTicket({
        ticketId: instTicket._id,
        user: platformAdminUser
      })).rejects.toMatchObject({ statusCode: 400, code: 'MAX_ESCALATION_REACHED' });
    });
  });

  // ==========================================
  // 8. submitFeedback
  // ==========================================
  describe('submitFeedback', () => {
    let ticket;

    beforeEach(async () => {
      ticket = await ticketService.createTicket({
        creator: learnerUser,
        subject: 'Feedback test ticket',
        issueType: 'technical',
        description: 'Need help'
      });
    });

    test('should throw 400 INVALID_TICKET_STATE if ticket is not resolved or closed', async () => {
      await expect(ticketService.submitFeedback({
        ticketId: ticket._id,
        rating: 5,
        comment: 'Great support',
        user: learnerUser
      })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_TICKET_STATE' });
    });

    test('should throw 403 FORBIDDEN if non-creator tries to submit feedback', async () => {
      await ticketService.updateTicketStatus({
        ticketId: ticket._id,
        status: 'resolved',
        user: platformAdminUser
      });

      await expect(ticketService.submitFeedback({
        ticketId: ticket._id,
        rating: 5,
        user: tutorUser
      })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    });

    test('creator can submit feedback on resolved ticket', async () => {
      await ticketService.updateTicketStatus({
        ticketId: ticket._id,
        status: 'resolved',
        user: platformAdminUser
      });

      const updated = await ticketService.submitFeedback({
        ticketId: ticket._id,
        rating: 5,
        comment: 'Fast resolution, thank you!',
        user: learnerUser
      });

      expect(updated.feedback).toBeDefined();
      expect(updated.feedback.rating).toBe(5);
      expect(updated.feedback.comment).toBe('Fast resolution, thank you!');
      expect(updated.feedback.submittedAt).toBeDefined();
    });

    test('should throw 400 FEEDBACK_ALREADY_SUBMITTED if feedback is submitted twice', async () => {
      await ticketService.updateTicketStatus({
        ticketId: ticket._id,
        status: 'resolved',
        user: platformAdminUser
      });

      await ticketService.submitFeedback({
        ticketId: ticket._id,
        rating: 4,
        user: learnerUser
      });

      await expect(ticketService.submitFeedback({
        ticketId: ticket._id,
        rating: 5,
        user: learnerUser
      })).rejects.toMatchObject({ statusCode: 400, code: 'FEEDBACK_ALREADY_SUBMITTED' });
    });
  });

  // ==========================================
  // 9. getTicketAuditLogs
  // ==========================================
  describe('getTicketAuditLogs', () => {
    let ticket;

    beforeEach(async () => {
      ticket = await ticketService.createTicket({
        creator: learnerUser,
        subject: 'Audit log test ticket',
        issueType: 'technical',
        description: 'Logging operations'
      });
    });

    test('should throw 403 FORBIDDEN if learner attempts to read audit logs', async () => {
      await expect(ticketService.getTicketAuditLogs(ticket._id, learnerUser))
        .rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    });

    test('platform admin can retrieve ticket audit logs', async () => {
      const logs = await ticketService.getTicketAuditLogs(ticket._id, platformAdminUser);
      expect(logs).toBeDefined();
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].action).toBe('TICKET_CREATED');
      expect(logs[0].actorUserId).toBeDefined();
    });
  });
});
