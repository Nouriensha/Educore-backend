const LiveSession = require('../models/liveSession.model');
const LiveRecording = require('../models/liveRecording.model');
const Attendance = require('../models/attendance.model');
const Enrollment = require('../models/enrollment.model');
const Course = require('../models/course.model');
const User = require('../models/user.model');
const Batch = require('../models/batch.model');
const { ApiError } = require('../utils/errors');
const googleCalendarService = require('./googleCalendar.service');
const { 
  triggerClassScheduled, 
  scheduleClassReminder, 
  removeClassReminder, 
  triggerClassCancelled,
  triggerClassRescheduled
} = require('../queues/liveClass.queue');
const cron = require('node-cron');

const createSession = async (tutorId, sessionData) => {
  const { courseId, batchId, title, description, startTime, endTime, timezone, durationMinutes } = sessionData;

  // Validate course ownership
  const course = await Course.findOne({ _id: courseId, authorId: tutorId, deletedAt: null });
  if (!course) {
    throw new ApiError(403, 'You do not have permission to schedule a session for this course.', 'FORBIDDEN');
  }

  // Get tutor profile
  const tutor = await User.findById(tutorId).select('+googleRefreshToken institutionId');
  if (!tutor) {
    throw new ApiError(404, 'Tutor user not found', 'NOT_FOUND');
  }

  const courseAuthor = await User.findById(course.authorId).select('institutionId');
  const isInstitutional = (tutor && tutor.institutionId) || (courseAuthor && courseAuthor.institutionId);

  if (isInstitutional && !batchId) {
    throw new ApiError(400, 'Live classes for institutional courses must be linked to a Batch Cohort.', 'BATCH_REQUIRED');
  }

  let batch = null;
  if (batchId) {
    batch = await Batch.findOne({
      _id: batchId,
      assignedTutorId: tutorId,
      deletedAt: null,
      status: { $ne: 'archived' }
    }).lean();

    if (!batch) {
      throw new ApiError(403, 'You do not have permission to schedule a session for this batch.', 'FORBIDDEN');
    }
  }

  // Get enrolled snapshot count
  const enrolledCount = batch
    ? batch.students.length
    : await Enrollment.countDocuments({ courseId, status: 'active', deletedAt: null });

  // Get tutor's Google Refresh Token
  if (!tutor.googleRefreshToken) {
    throw new ApiError(400, 'Please connect your Google account in Settings to schedule Live Classes.', 'GOOGLE_AUTH_MISSING');
  }

  // Create Google Meet first
  const meetData = await googleCalendarService.createMeeting({
    refreshToken: tutor.googleRefreshToken,
    title,
    description,
    startTime,
    endTime,
    timezone
  });

  let session;
  try {
    session = await LiveSession.create({
      courseId,
      tutorId,
      batchId: batchId || null,
      title,
      description,
      startTime,
      endTime,
      timezone,
      durationMinutes,
      meetingId: meetData.meetingId,
      meetingUrl: meetData.meetingUrl,
      enrolledSnapshotCount: enrolledCount
    });
  } catch (error) {
    // Rollback Google Meet event if DB save fails
    if (meetData && meetData.meetingId) {
      await googleCalendarService.cancelMeeting(meetData.meetingId).catch(console.error);
    }
    throw error;
  }

  const sessionPayload = {
    sessionId: session._id,
    title: session.title,
    courseId: session.courseId,
    tutorName: 'Your Tutor', // Ideally fetch from tutor user profile
    startTime: session.startTime,
    timezone: session.timezone,
    timeStr: new Date(session.startTime).toLocaleString('en-US', { timeZone: session.timezone })
  };

  await triggerClassScheduled(sessionPayload);
  await scheduleClassReminder(session._id, sessionPayload);

  return session;
};

const updateSession = async (tutorId, sessionId, updateData) => {
  if (updateData.batchId === '') {
    updateData.batchId = null;
  }

  const session = await LiveSession.findOne({ _id: sessionId, tutorId, deletedAt: null });
  if (!session) {
    throw new ApiError(404, 'Live session not found', 'NOT_FOUND');
  }

  if (session.status !== 'scheduled' && session.status !== 'rescheduled') {
    throw new ApiError(400, 'Cannot update a session that is already live, completed, or cancelled', 'BAD_REQUEST');
  }

  const tutor = await User.findById(tutorId).select('+googleRefreshToken institutionId');
  const course = await Course.findById(session.courseId).select('authorId');
  const courseAuthor = course ? await User.findById(course.authorId).select('institutionId') : null;
  const isInstitutional = (tutor && tutor.institutionId) || (courseAuthor && courseAuthor.institutionId);

  const finalBatchId = updateData.batchId !== undefined ? updateData.batchId : session.batchId;
  if (isInstitutional && !finalBatchId) {
    throw new ApiError(400, 'Live classes for institutional courses must be linked to a Batch Cohort.', 'BATCH_REQUIRED');
  }

  const newStartTime = updateData.startTime || session.startTime;
  const newEndTime = updateData.endTime || session.endTime;
  const newTimezone = updateData.timezone || session.timezone;

  if (updateData.batchId !== undefined && updateData.batchId) {
    const batch = await Batch.findOne({
      _id: updateData.batchId,
      assignedTutorId: tutorId,
      deletedAt: null,
      status: { $ne: 'archived' }
    }).select('_id');

    if (!batch) {
      throw new ApiError(403, 'You do not have permission to schedule a session for this batch.', 'FORBIDDEN');
    }
  }

  if (updateData.startTime || updateData.endTime || updateData.title || updateData.description) {
    await googleCalendarService.updateMeeting(session.meetingId, {
      refreshToken: tutor?.googleRefreshToken,
      title: updateData.title || session.title,
      description: updateData.description || session.description,
      startTime: newStartTime,
      endTime: newEndTime,
      timezone: newTimezone
    });
  }

  const updatedSession = await LiveSession.findByIdAndUpdate(
    sessionId,
    { 
      ...updateData,
      status: (updateData.startTime && new Date(updateData.startTime).getTime() !== new Date(session.startTime).getTime()) ? 'rescheduled' : session.status
    },
    { new: true }
  );

  const sessionPayload = {
    sessionId: updatedSession._id,
    title: updatedSession.title,
    courseId: updatedSession.courseId,
    tutorName: 'Your Tutor',
    startTime: updatedSession.startTime,
    timezone: updatedSession.timezone,
    timeStr: new Date(updatedSession.startTime).toLocaleString('en-US', { timeZone: updatedSession.timezone })
  };

  if (updatedSession.status === 'rescheduled') {
    await removeClassReminder(sessionId);
    await triggerClassRescheduled(sessionPayload);
    await scheduleClassReminder(sessionId, sessionPayload);
  }

  return updatedSession;
};

const cancelSession = async (tutorId, sessionId) => {
  const session = await LiveSession.findOne({ _id: sessionId, tutorId, deletedAt: null });
  if (!session) {
    throw new ApiError(404, 'Live session not found', 'NOT_FOUND');
  }

  if (session.status === 'cancelled') {
    return session;
  }

  // Cancel Google Calendar Event
  if (session.meetingId) {
    const tutor = await User.findById(tutorId).select('+googleRefreshToken');
    await googleCalendarService.cancelMeeting(session.meetingId, tutor?.googleRefreshToken);
  }

  session.status = 'cancelled';
  await session.save();

  await removeClassReminder(sessionId);

  const sessionPayload = {
    sessionId: session._id,
    title: session.title,
    courseId: session.courseId,
    tutorName: 'Your Tutor',
    startTime: session.startTime,
    timezone: session.timezone,
    timeStr: new Date(session.startTime).toLocaleString('en-US', { timeZone: session.timezone })
  };
  await triggerClassCancelled(sessionPayload);

  return session;
};

const getJoinUrl = async (userId, role, sessionId) => {
  const session = await LiveSession.findOne({ _id: sessionId, deletedAt: null });
  if (!session) {
    throw new ApiError(404, 'Live session not found', 'NOT_FOUND');
  }

  if (session.status === 'cancelled') {
    throw new ApiError(403, 'This session has been cancelled', 'SESSION_CANCELLED');
  }

  if (role === 'tutor') {
    if (session.tutorId.toString() !== userId.toString()) {
      throw new ApiError(403, 'You do not have permission to join this session', 'FORBIDDEN');
    }
  } else if (role === 'learner') {
    if (session.batchId) {
      const batch = await Batch.findOne({
        _id: session.batchId,
        'students.userId': userId,
        deletedAt: null
      }).select('_id');

      if (!batch) {
        throw new ApiError(403, 'You must belong to this batch to join', 'FORBIDDEN');
      }
    } else {
      // Check enrollment
      const enrollment = await Enrollment.findOne({ userId, courseId: session.courseId, status: 'active', deletedAt: null });
      if (!enrollment) {
        throw new ApiError(403, 'You must be actively enrolled in the course to join', 'FORBIDDEN');
      }
    }
  } else {
    throw new ApiError(403, 'Invalid role', 'FORBIDDEN');
  }

  const now = new Date().getTime();
  const startTime = new Date(session.startTime).getTime();
  const endTime = new Date(session.endTime).getTime();

  // Allow joining strictly 10 minutes before start to match US-LIVE-003
  const tenMinsBefore = startTime - (10 * 60 * 1000);

  if (now < tenMinsBefore) {
    throw new ApiError(403, 'You can only join 10 minutes before the session starts', 'TOO_EARLY');
  }

  if (now > endTime) {
    throw new ApiError(403, 'This session has already ended', 'SESSION_ENDED');
  }

  return session.meetingUrl;
};

// Cron Jobs for Status Automation
const startStatusAutomation = () => {
  // Run every minute
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      
      // scheduled/rescheduled -> live
      await LiveSession.updateMany(
        { status: { $in: ['scheduled', 'rescheduled'] }, startTime: { $lte: now }, endTime: { $gt: now }, deletedAt: null },
        { $set: { status: 'live' } }
      );

      // live -> completed
      await LiveSession.updateMany(
        { status: 'live', endTime: { $lte: now }, deletedAt: null },
        { $set: { status: 'completed' } }
      );

    } catch (error) {
      console.error('[CRON] Error updating live session statuses:', error);
    }
  });
};

// Initiate cron on load (except during test runs)
if (process.env.NODE_ENV !== 'test') {
  startStatusAutomation();
}

module.exports = {
  createSession,
  updateSession,
  cancelSession,
  getJoinUrl
};
