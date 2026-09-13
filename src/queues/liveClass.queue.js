const { Queue, Worker } = require('bullmq');
const env = require('../config/env');
const IORedis = require('ioredis');

const QUEUE_NAME = 'live-class-events';

let liveClassQueue = null;
const activeTimeouts = new Map();

const processLiveClassJob = async (type, payload) => {
  const { sendMail } = require('../services/email.service');
  const { createNotification } = require('../services/notification.service');
  const Enrollment = require('../models/enrollment.model');
  const User = require('../models/user.model');
  const LiveSession = require('../models/liveSession.model');
  
  console.log(`[LiveClass Worker/Fallback] Processing job of type ${type}`);

  try {
    if (type === 'LIVE_CLASS_EMAIL_REMINDER' || type === 'LIVE_CLASS_INAPP_REMINDER') {
      const { sessionId } = payload;
      const session = await LiveSession.findById(sessionId).lean();
      if (!session || session.status === 'cancelled') {
        console.log(`[LiveClass Worker] Live session ${sessionId} not found or cancelled. Skipping reminder.`);
        return;
      }

      const timeStr = new Date(session.startTime).toLocaleString('en-US', { timeZone: session.timezone || 'Asia/Kolkata' });

      // Notify the tutor (host) first
      try {
        const Course = require('../models/course.model');
        const course = await Course.findById(session.courseId).lean();
        const tutorId = session.tutorId || (course ? course.authorId : null);
        if (tutorId) {
          const tutor = await User.findById(tutorId).lean();
          if (tutor) {
            const settings = tutor.notificationSettings?.liveClassReminder || { email: true, inApp: true };
            const emailEnabled = settings.email !== false;
            const inAppEnabled = settings.inApp !== false;

            if (type === 'LIVE_CLASS_EMAIL_REMINDER' && emailEnabled) {
              const subject = `Live Class Reminder: ${session.title}`;
              const tutorJoinLink = `${env.client.url}/tutor-dashboard/live-sessions/manage`;
              try {
                await sendMail({
                  to: tutor.email,
                  name: tutor.name || 'Tutor',
                  subject,
                  text: `Hello ${tutor.name},\n\nThis is a reminder that your scheduled live class "${session.title}" will start on ${timeStr}.\n\nManage your session here: ${tutorJoinLink}\n\nBest regards,\nEduCore Team`,
                  html: `
                    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eef2e8; border-radius: 16px;">
                      <h2 style="color: #435947;">Live Class Reminder (Host)</h2>
                      <p>Hello <strong>${tutor.name}</strong>,</p>
                      <p>This is a reminder that your scheduled live class <strong>"${session.title}"</strong> is scheduled to start at:</p>
                      <div style="background-color: #f3f4ee; padding: 20px; border-radius: 12px; margin: 20px 0;">
                        <p style="margin: 5px 0;"><strong>Class:</strong> ${session.title}</p>
                        <p style="margin: 5px 0;"><strong>Time:</strong> ${timeStr}</p>
                      </div>
                      <p>Manage the session and join via Meet by clicking below:</p>
                      <div style="text-align: center; margin: 30px 0;">
                        <a href="${tutorJoinLink}" style="background-color: #556b57; color: white; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block;">Manage Session</a>
                      </div>
                    </div>
                  `
                });
              } catch (mailErr) {
                console.error(`[LiveClass Worker] Failed to send email reminder to tutor ${tutor.email}:`, mailErr.message);
              }
            }

            if (type === 'LIVE_CLASS_INAPP_REMINDER' && inAppEnabled) {
              try {
                await createNotification({
                  userId: tutor._id.toString(),
                  type: 'system',
                  title: `Live Class Starting Soon: ${session.title}`,
                  message: `Your scheduled live class "${session.title}" starts in 30 minutes (${timeStr}). Click here to manage it.`,
                  metadata: { sessionId: session._id.toString(), courseId: session.courseId.toString(), eventType: type }
                });
              } catch (notifErr) {
                console.error(`[LiveClass Worker] Failed to create in-app reminder for tutor ${tutor._id}:`, notifErr.message);
              }
            }
          }
        }
      } catch (tutorErr) {
        console.error('[LiveClass Worker] Failed to process tutor live class reminder:', tutorErr);
      }

      // Get all enrolled active learners
      const enrollments = await Enrollment.find({ courseId: session.courseId, status: 'active', deletedAt: null }).lean();
      if (!enrollments.length) return;

      const userIds = enrollments.map(e => e.userId);
      const users = await User.find({ _id: { $in: userIds } }).lean();

      const joinLink = `${env.client.url}/learner-dashboard/live-sessions/${session._id}`;

      for (const user of users) {
        const settings = user.notificationSettings?.liveClassReminder || { email: true, inApp: true };
        const emailEnabled = settings.email !== false;
        const inAppEnabled = settings.inApp !== false;

        if (type === 'LIVE_CLASS_EMAIL_REMINDER' && emailEnabled) {
          const subject = `Live Class Reminder: ${session.title}`;
          const text = `Hello ${user.name},\n\nThis is a reminder that the live class "${session.title}" will start on ${timeStr}.\n\nJoin the session using this link: ${joinLink}\n\nBest regards,\nEduCore Team`;
          
          try {
            await sendMail({
              to: user.email,
              name: user.name || 'Learner',
              subject,
              text,
              html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eef2e8; border-radius: 16px;">
                  <h2 style="color: #435947;">Live Class Reminder</h2>
                  <p>Hello <strong>${user.name}</strong>,</p>
                  <p>This is a reminder that the live class <strong>"${session.title}"</strong> is scheduled to start at:</p>
                  <div style="background-color: #f3f4ee; padding: 20px; border-radius: 12px; margin: 20px 0;">
                    <p style="margin: 5px 0;"><strong>Class:</strong> ${session.title}</p>
                    <p style="margin: 5px 0;"><strong>Time:</strong> ${timeStr}</p>
                  </div>
                  <p>Join the session by clicking the button below:</p>
                  <div style="text-align: center; margin: 30px 0;">
                    <a href="${joinLink}" style="background-color: #556b57; color: white; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block;">Join Live Session</a>
                  </div>
                </div>
              `
            });
          } catch (mailErr) {
            console.error(`[LiveClass Worker] Failed to send email reminder to ${user.email}:`, mailErr.message);
          }
        }

        if (type === 'LIVE_CLASS_INAPP_REMINDER' && inAppEnabled) {
          const subject = `Live Class Starting Soon: ${session.title}`;
          const text = `Your live class "${session.title}" starts in 30 minutes (${timeStr}). Click here to join.`;
          
          try {
            await createNotification({
              userId: user._id.toString(),
              type: 'system',
              title: subject,
              message: text,
              metadata: { sessionId: session._id.toString(), courseId: session.courseId.toString(), eventType: type }
            });
          } catch (notifErr) {
            console.error(`[LiveClass Worker] Failed to create in-app reminder for user ${user._id}:`, notifErr.message);
          }
        }
      }
      return;
    }

    if (type === 'LIVE_CLASS_SCHEDULED' || type === 'LIVE_CLASS_REMINDER' || type === 'LIVE_CLASS_CANCELLED' || type === 'LIVE_CLASS_RESCHEDULED') {
      const { sessionId, title, courseId, tutorName, timeStr } = payload;
      
      // Get all enrolled learners for this course
      const enrollments = await Enrollment.find({ courseId, status: 'active', deletedAt: null }).lean();
      if (!enrollments.length) return;
      
      const userIds = enrollments.map(e => e.userId);
      const users = await User.find({ _id: { $in: userIds } }).lean();

      for (const user of users) {
        let subject = '';
        
        let text = '';
        
        if (type === 'LIVE_CLASS_SCHEDULED') {
          subject = `New Live Class Scheduled: ${title}`;
          text = `Hello ${user.name}, your tutor ${tutorName} has scheduled a new live class "${title}" for ${timeStr}.`;
        } else if (type === 'LIVE_CLASS_REMINDER') {
          subject = `Reminder: Live Class "${title}" starts in 15 minutes!`;
          text = `Hello ${user.name}, just a reminder that your live class "${title}" is starting in 15 minutes. Join via your dashboard.`;
        } else if (type === 'LIVE_CLASS_CANCELLED') {
          subject = `Cancelled: Live Class "${title}"`;
          text = `Hello ${user.name}, the live class "${title}" scheduled for ${timeStr} has been cancelled by the tutor.`;
        } else if (type === 'LIVE_CLASS_RESCHEDULED') {
          subject = `Rescheduled: Live Class "${title}"`;
          text = `Hello ${user.name}, the live class "${title}" has been rescheduled to ${timeStr}.`;
        }

        // Create DB Notification & Send SSE
        await createNotification({
          userId: user._id.toString(),
          type: 'system',
          title: subject,
          message: text,
          metadata: { sessionId, courseId, eventType: type }
        });

        // Send actual email
        try {
          await sendMail({
            to: user.email,
            name: user.name || 'Learner',
            subject,
            text,
            html: `<p>${text}</p>`
          });
        } catch (mailErr) {
          console.error(`[LiveClass Worker/Fallback] Failed to send email to ${user.email}:`, mailErr);
        }
      }
    } else if (type === 'RECORDING_PUBLISHED') {
      const { recordingId, title, courseId } = payload;
      const enrollments = await Enrollment.find({ courseId, status: 'active', deletedAt: null }).lean();
      if (!enrollments.length) return;
      
      const userIds = enrollments.map(e => e.userId);
      const users = await User.find({ _id: { $in: userIds } }).lean();

      for (const user of users) {
        const titleMsg = `Live Recording Available: ${title}`;
        const bodyMsg = `A new live recording "${title}" has been published and is available in your course dashboard.`;
        
        // Create DB Notification & Send SSE
        await createNotification({
          userId: user._id.toString(),
          type: 'system',
          title: titleMsg,
          message: bodyMsg,
          metadata: { recordingId, courseId, eventType: type }
        });

        // Send actual email
        try {
          await sendMail({
            to: user.email,
            name: user.name || 'Learner',
            subject: titleMsg,
            text: bodyMsg,
            html: `<p>${bodyMsg}</p>`
          });
        } catch (mailErr) {
          console.error(`[LiveClass Worker/Fallback] Failed to send email to ${user.email}:`, mailErr);
        }
      }
    }
  } catch (err) {
    console.error(`[LiveClass Worker/Fallback] Job processing error:`, err);
    throw err;
  }
};

if (process.env.NODE_ENV !== 'test' && (env.redis.driver === 'redis' || (env.redis.driver === 'auto' && env.redis.url))) {
  const connection = new IORedis(env.redis.url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
  });
  
  liveClassQueue = new Queue(QUEUE_NAME, { connection });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { type, payload } = job.data;
      await processLiveClassJob(type, payload);
    },
    { connection }
  );

  worker.on('failed', (job, err) => {
    console.error(`[LiveClass Worker] Job failed for ${job?.id}`, err);
  });
}

/**
 * Triggers immediate notification when a class is scheduled
 */
const triggerClassScheduled = async (sessionData) => {
  if (!liveClassQueue) {
    return processLiveClassJob('LIVE_CLASS_SCHEDULED', sessionData).catch(console.error);
  }
  await liveClassQueue.add('class-scheduled', {
    type: 'LIVE_CLASS_SCHEDULED',
    payload: sessionData
  });
};

const scheduleClassReminder = async (sessionId, sessionData) => {
  const startTime = new Date(sessionData.startTime).getTime();

  // 1. Email reminder: 24 hours before class starts
  const emailTime = startTime - (24 * 60 * 60 * 1000);
  const emailDelay = emailTime - Date.now();

  // 2. In-app reminder: 30 minutes before class starts
  const inAppTime = startTime - (30 * 60 * 1000);
  const inAppDelay = inAppTime - Date.now();

  // Clean up any existing timeouts first
  const existing = activeTimeouts.get(sessionId.toString());
  if (existing) {
    clearTimeout(existing.emailTimeout);
    clearTimeout(existing.inAppTimeout);
    activeTimeouts.delete(sessionId.toString());
  }

  if (!liveClassQueue) {
    // Fallback: Use setTimeout for local testing without Redis
    if (startTime - Date.now() > 0) {
      const emailTimeout = setTimeout(() => {
        processLiveClassJob('LIVE_CLASS_EMAIL_REMINDER', sessionData).catch(console.error);
      }, Math.max(0, emailDelay));

      const inAppTimeout = setTimeout(() => {
        processLiveClassJob('LIVE_CLASS_INAPP_REMINDER', sessionData).catch(console.error);
      }, Math.max(0, inAppDelay));

      activeTimeouts.set(sessionId.toString(), { emailTimeout, inAppTimeout });
    }
    return;
  }

  // Schedule email job if class has not started yet
  if (startTime - Date.now() > 0) {
    const emailJobId = `live-email-reminder-${sessionId}`;
    await liveClassQueue.add('class-email-reminder', {
      type: 'LIVE_CLASS_EMAIL_REMINDER',
      payload: sessionData
    }, {
      delay: Math.max(0, emailDelay),
      jobId: emailJobId
    });

    const inAppJobId = `live-inapp-reminder-${sessionId}`;
    await liveClassQueue.add('class-inapp-reminder', {
      type: 'LIVE_CLASS_INAPP_REMINDER',
      payload: sessionData
    }, {
      delay: Math.max(0, inAppDelay),
      jobId: inAppJobId
    });
  }
};

const removeClassReminder = async (sessionId) => {
  const existing = activeTimeouts.get(sessionId.toString());
  if (existing) {
    clearTimeout(existing.emailTimeout);
    clearTimeout(existing.inAppTimeout);
    activeTimeouts.delete(sessionId.toString());
  }

  if (!liveClassQueue) return;
  const emailJobId = `live-email-reminder-${sessionId}`;
  const inAppJobId = `live-inapp-reminder-${sessionId}`;
  
  const emailJob = await liveClassQueue.getJob(emailJobId);
  if (emailJob) {
    await emailJob.remove();
  }
  const inAppJob = await liveClassQueue.getJob(inAppJobId);
  if (inAppJob) {
    await inAppJob.remove();
  }
};

const triggerClassCancelled = async (sessionData) => {
  if (!liveClassQueue) {
    return processLiveClassJob('LIVE_CLASS_CANCELLED', sessionData).catch(console.error);
  }
  await liveClassQueue.add('class-cancelled', {
    type: 'LIVE_CLASS_CANCELLED',
    payload: sessionData
  });
};

const triggerClassRescheduled = async (sessionData) => {
  if (!liveClassQueue) {
    return processLiveClassJob('LIVE_CLASS_RESCHEDULED', sessionData).catch(console.error);
  }
  await liveClassQueue.add('class-rescheduled', {
    type: 'LIVE_CLASS_RESCHEDULED',
    payload: sessionData
  });
};

const triggerRecordingPublished = async (recordingData) => {
  if (!liveClassQueue) {
    return processLiveClassJob('RECORDING_PUBLISHED', recordingData).catch(console.error);
  }
  await liveClassQueue.add('recording-published', {
    type: 'RECORDING_PUBLISHED',
    payload: recordingData
  });
};

module.exports = {
  processLiveClassJob,
  triggerClassScheduled,
  scheduleClassReminder,
  removeClassReminder,
  triggerClassCancelled,
  triggerClassRescheduled,
  triggerRecordingPublished
};
