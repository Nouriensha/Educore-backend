const { Queue, Worker } = require('bullmq');
const env = require('../config/env');
const IORedis = require('ioredis');

const QUEUE_NAME = 'certificate-generation';

let certificateQueue = null;

/**
 * Common certificate generation logic, shared between background worker and synchronous fallback.
 */
const generateCertificateSynchronously = async (certificateId) => {
  console.log(`[Certificate Queue] Processing certificate: ${certificateId}`);
  
  const Certificate = require('../models/certificate.model');
  const Course = require('../models/course.model');
  const User = require('../models/user.model');
  const Institution = require('../models/institution.model');
  const CertificateTemplate = require('../models/certificateTemplate.model');
  const { generateCertificatePdf } = require('../utils/pdf.util');
  const path = require('path');
  const fs = require('fs');

  const cert = await Certificate.findById(certificateId);
  if (!cert) {
    console.error(`[Certificate Queue] Certificate ${certificateId} not found in database.`);
    return;
  }

  if (cert.status === 'issued') {
    console.log(`[Certificate Queue] Certificate ${cert.certificateNumber} is already issued.`);
    return;
  }

  const [course, learner] = await Promise.all([
    Course.findById(cert.courseId).lean(),
    User.findById(cert.userId).select('name email').lean()
  ]);

  if (!course || !learner) {
    cert.status = 'failed';
    await cert.save();
    console.error(`[Certificate Queue] Course or Learner not found for certificate ${cert.certificateNumber}`);
    return;
  }

  const tutor = await User.findById(course.authorId).select('name').lean();
  const template = await CertificateTemplate.findById(cert.templateId).lean();
  
  let institution = null;
  if (course.institutionId) {
    institution = await Institution.findById(course.institutionId).lean();
  }

  const uploadsDir = path.join(__dirname, '../../uploads/certificates');
  if (!process.env.VERCEL) {
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
  }

  const fileName = `${cert.certificateNumber}.pdf`;
  const filePath = path.join(uploadsDir, fileName);

  const verificationUrl = `${env.client.url}/certificates/validate/${cert.certificateNumber}`;
  const pdfUrl = `${env.client.apiPublicUrl}/uploads/certificates/${fileName}`;

  cert.verificationUrl = verificationUrl;
  cert.pdfUrl = pdfUrl;

  try {
    const pdfBuffer = await generateCertificatePdf(cert, course, learner, tutor, template, institution);
    if (!process.env.VERCEL) {
      fs.writeFileSync(filePath, pdfBuffer);
    }

    cert.status = 'issued';
    cert.blockchainTxId = `tx_${Date.now()}`;
    await cert.save();

    console.log(`[Certificate Queue] Certificate ${cert.certificateNumber} issued successfully at ${filePath}`);

    // Trigger in-app notification
    try {
      const notificationService = require('../services/notification.service');
      await notificationService.createNotification({
        userId: learner._id.toString(),
        title: 'Certificate Issued!',
        message: `Congratulations! Your certificate for "${course.title}" has been issued. Download it here: ${cert.pdfUrl}`,
        type: 'system',
        metadata: {
          courseId: course._id.toString(),
          certificateId: cert._id.toString(),
          certificateNumber: cert.certificateNumber,
          pdfUrl: cert.pdfUrl
        }
      });
    } catch (notifErr) {
      console.error('[Certificate Queue] Failed to send in-app notification:', notifErr.message);
    }

    // Trigger email
    try {
      const emailService = require('../services/email.service');
      await emailService.sendCertificateEmail({
        to: learner.email,
        name: learner.name,
        courseTitle: course.title,
        pdfUrl: cert.pdfUrl,
        certificateBuffer: pdfBuffer
      });
    } catch (emailErr) {
      console.error('[Certificate Queue] Failed to send certificate email:', emailErr.message);
    }
  } catch (genErr) {
    cert.status = 'failed';
    await cert.save();
    console.error(`[Certificate Queue] Failed to generate/write PDF for ${cert.certificateNumber}:`, genErr);
  }
};

// Only initialize BullMQ if we have a real redis URL (not memory or upstash-rest)
if (process.env.NODE_ENV !== 'test' && (env.redis.driver === 'redis' || (env.redis.driver === 'auto' && env.redis.url))) {
  const connection = new IORedis(env.redis.url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
  });
  
  certificateQueue = new Queue(QUEUE_NAME, { connection });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      console.log(`[Certificate Worker] Processing job ${job.id} for certificate ${job.data.certificateId}`);
      await generateCertificateSynchronously(job.data.certificateId);
    },
    { connection }
  );

  worker.on('failed', (job, err) => {
    console.error(`[Certificate Worker] Job failed for ${job?.id}`, err);
  });
}

/**
 * Triggers asynchronous certificate generation.
 * Failures here (like Redis being down) should NOT block the caller.
 */
const triggerCertificateGeneration = async ({ userId, courseId }) => {
  try {
    const Certificate = require('../models/certificate.model');
    const Course = require('../models/course.model');

    // Check if certificate already exists to prevent duplicates
    const existingCert = await Certificate.findOne({ userId, courseId });
    if (existingCert) {
      return existingCert;
    }

    // Fetch the course to freeze template and verify certificate settings
    const course = await Course.findOne({ _id: courseId, deletedAt: null }).lean();
    if (!course || !course.certificateEnabled) {
      console.warn(`[Certificate Queue] Course ${courseId} does not have certificates enabled.`);
      return null;
    }

    // Create placeholder certificate synchronously so frontend knows it's processing
    const certificateNumber = `CERT-${userId.toString().slice(-4)}-${courseId.toString().slice(-4)}-${Date.now().toString().slice(-4)}`;
    const newCert = await Certificate.create({
      userId,
      courseId,
      certificateNumber,
      templateId: course.certificateTemplateId,
      templateVersion: course.certificateTemplateVersion,
      status: 'processing'
    });

    if (certificateQueue) {
      // Dispatch background job
      await certificateQueue.add('generate-certificate', {
        userId,
        courseId,
        certificateId: newCert._id
      });
    } else {
      console.warn('[Certificate Queue] BullMQ is disabled (using memory/upstash driver). Running certificate generation synchronously.');
      // Execute synchronously as fallback
      setTimeout(async () => {
        try {
          await generateCertificateSynchronously(newCert._id);
        } catch (syncErr) {
          console.error('[Certificate Queue] Synchronous generation failed:', syncErr.message);
        }
      }, 0);
    }

    return newCert;
  } catch (error) {
    console.error('[Certificate Queue] Failed to trigger generation:', error.message);
    return null;
  }
};

module.exports = {
  triggerCertificateGeneration,
  generateCertificateSynchronously
};
