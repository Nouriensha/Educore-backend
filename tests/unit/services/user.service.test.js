const mongoose = require('mongoose');
const userService = require('../../../src/services/user.service');
const User = require('../../../src/models/user.model');
const InstitutionMembership = require('../../../src/models/institutionMembership.model');
const AuditLog = require('../../../src/models/auditLog.model');
const { ApiError } = require('../../../src/utils/errors');
const { hashPassword } = require('../../../src/utils/password');
const { connectDB, closeDB, clearDB } = require('../../setup/test-db');
const { buildUser } = require('../../fixtures/user.fixture');

// Mock storage service
jest.mock('../../../src/services/storage.service', () => ({
  uploadAvatar: jest.fn().mockResolvedValue('https://res.cloudinary.com/demo/image/upload/avatar_123.jpg'),
  uploadTutorCredential: jest.fn().mockImplementation(async ({ file }) => ({
    title: file?.originalname || 'aadhaar.pdf',
    fileUrl: 'https://res.cloudinary.com/demo/raw/upload/aadhaar_123.pdf',
    publicId: 'raw/aadhaar_123',
    resourceType: 'raw',
    mimeType: file?.mimetype || 'application/pdf',
    size: 102400
  })),
  uploadTutorSampleVideo: jest.fn().mockResolvedValue({
    videoUrl: 'https://res.cloudinary.com/demo/video/upload/sample_123.mp4',
    publicId: 'video/sample_123',
    resourceType: 'video',
    videoStatus: 'ready'
  }),
  deleteResource: jest.fn().mockResolvedValue(true)
}));

// Mock Mux service
jest.mock('../../../src/services/mux.service', () => ({
  createDirectUpload: jest.fn().mockResolvedValue({
    id: 'mux_upload_id_123',
    url: 'https://upload.mux.com/direct/123'
  }),
  getUploadStatus: jest.fn().mockResolvedValue({
    status: 'asset_created',
    asset_id: 'mux_asset_id_123'
  }),
  getAssetDetails: jest.fn().mockResolvedValue({
    status: 'ready',
    playback_ids: [{ id: 'playback_id_123' }]
  }),
  deleteAsset: jest.fn().mockResolvedValue(true)
}));

// Mock OTP service
jest.mock('../../../src/services/otp.service', () => ({
  PURPOSES: {
    EMAIL_VERIFICATION: 'email_verification',
    EMAIL_CHANGE: 'email_change'
  },
  enforceResendCooldown: jest.fn().mockResolvedValue(true),
  createOtp: jest.fn().mockResolvedValue('123456'),
  verifyOtp: jest.fn().mockResolvedValue({ newEmail: 'newemail@example.com' })
}));

// Mock Email service
jest.mock('../../../src/services/email.service', () => ({
  sendEmailChangeOtp: jest.fn().mockResolvedValue(true)
}));

// Mock Session service
jest.mock('../../../src/services/session.service', () => ({
  revokeAllUserSessions: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
  revokeOtherUserSessions: jest.fn().mockResolvedValue({ modifiedCount: 1 })
}));

const storageService = require('../../../src/services/storage.service');
const muxService = require('../../../src/services/mux.service');
const otpService = require('../../../src/services/otp.service');
const emailService = require('../../../src/services/email.service');
const sessionService = require('../../../src/services/session.service');

describe('User Service Comprehensive Unit Tests', () => {
  let learner;
  let tutor;
  let admin;

  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await closeDB();
  });

  beforeEach(async () => {
    await clearDB();
    jest.clearAllMocks();

    const passwordHash = await hashPassword('CurrentPassword123!');

    learner = await User.create(buildUser({
      name: 'Test Learner',
      email: 'learner@example.com',
      passwordHash,
      role: 'learner',
      status: 'active'
    }));

    tutor = await User.create(buildUser({
      name: 'Test Tutor',
      email: 'tutor@example.com',
      passwordHash,
      role: 'tutor',
      status: 'active',
      profile: {
        bio: 'Experienced programming tutor'
      }
    }));

    admin = await User.create(buildUser({
      name: 'Test Admin',
      email: 'admin@example.com',
      passwordHash,
      role: 'admin',
      status: 'active'
    }));
  });

  // =========================================================================
  // 1. GET PROFILE & UPDATE PROFILE
  // =========================================================================
  describe('getProfile & updateProfile', () => {
    test('getProfile should return sanitized public user data for existing user', async () => {
      const result = await userService.getProfile({ userId: learner._id });

      expect(result.message).toBe('Profile retrieved successfully.');
      expect(result.data.user).toBeDefined();
      expect(result.data.user.email).toBe('learner@example.com');
      expect(result.data.user.passwordHash).toBeUndefined();
      expect(result.data.user.id).toBe(learner._id.toString());
    });

    test('getProfile should throw 404 USER_NOT_FOUND if user does not exist or is soft-deleted', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      await expect(userService.getProfile({ userId: nonExistentId }))
        .rejects.toThrow(ApiError);

      try {
        await userService.getProfile({ userId: nonExistentId });
      } catch (err) {
        expect(err.statusCode).toBe(404);
        expect(err.code).toBe('USER_NOT_FOUND');
      }

      await User.findByIdAndUpdate(learner._id, { deletedAt: new Date() });
      await expect(userService.getProfile({ userId: learner._id }))
        .rejects.toThrow('User not found');
    });

    test('updateProfile should update name and bio, and return updated public user', async () => {
      const result = await userService.updateProfile({
        userId: learner._id,
        payload: {
          name: 'Updated Learner Name',
          bio: 'Passionate about Web Development'
        }
      });

      expect(result.message).toBe('Profile updated successfully.');
      expect(result.data.user.name).toBe('Updated Learner Name');
      expect(result.data.user.profile.bio).toBe('Passionate about Web Development');

      const updated = await User.findById(learner._id);
      expect(updated.name).toBe('Updated Learner Name');
      expect(updated.profile.bio).toBe('Passionate about Web Development');
    });

    test('updateProfile should upload avatar image when file is provided', async () => {
      const file = { originalname: 'avatar.png', buffer: Buffer.from('fake-avatar') };

      const result = await userService.updateProfile({
        userId: learner._id,
        payload: { name: 'Learner With Avatar' },
        file
      });

      expect(storageService.uploadAvatar).toHaveBeenCalledWith({
        userId: learner._id,
        file
      });
      expect(result.data.user.profile.avatarUrl).toBe('https://res.cloudinary.com/demo/image/upload/avatar_123.jpg');

      const updated = await User.findById(learner._id);
      expect(updated.profile.avatarUrl).toBe('https://res.cloudinary.com/demo/image/upload/avatar_123.jpg');
    });

    test('updateProfile should return unchanged user if payload and file are empty', async () => {
      const result = await userService.updateProfile({
        userId: learner._id,
        payload: {}
      });

      expect(result.data.user.name).toBe(learner.name);
    });

    test('updateProfile should throw 404 USER_NOT_FOUND for non-existent or deleted user', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      await expect(userService.updateProfile({ userId: nonExistentId, payload: { name: 'Test' } }))
        .rejects.toThrow('User not found');
    });
  });

  // =========================================================================
  // 2. EMAIL CHANGE WORKFLOW (requestEmailChange & verifyEmailChange)
  // =========================================================================
  describe('Email Change Workflow', () => {
    test('requestEmailChange should throw 400 CURRENT_PASSWORD_INVALID if current password is wrong', async () => {
      await expect(userService.requestEmailChange({
        userId: learner._id,
        email: 'newemail@example.com',
        currentPassword: 'WrongPassword999!'
      })).rejects.toThrow(ApiError);

      try {
        await userService.requestEmailChange({
          userId: learner._id,
          email: 'newemail@example.com',
          currentPassword: 'WrongPassword999!'
        });
      } catch (err) {
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('CURRENT_PASSWORD_INVALID');
      }
    });

    test('requestEmailChange should return requiresVerification: false if email is unchanged', async () => {
      const result = await userService.requestEmailChange({
        userId: learner._id,
        email: 'learner@example.com',
        currentPassword: 'CurrentPassword123!'
      });

      expect(result.requiresVerification).toBe(false);
      expect(result.email).toBe('learner@example.com');
      expect(otpService.createOtp).not.toHaveBeenCalled();
    });

    test('requestEmailChange should throw 409 EMAIL_ALREADY_EXISTS if email is already taken by another user', async () => {
      await expect(userService.requestEmailChange({
        userId: learner._id,
        email: 'tutor@example.com', // Belongs to tutor
        currentPassword: 'CurrentPassword123!'
      })).rejects.toThrow(ApiError);

      try {
        await userService.requestEmailChange({
          userId: learner._id,
          email: 'tutor@example.com',
          currentPassword: 'CurrentPassword123!'
        });
      } catch (err) {
        expect(err.statusCode).toBe(409);
        expect(err.code).toBe('EMAIL_ALREADY_EXISTS');
      }
    });

    test('requestEmailChange should enforce cooldown, create OTP, and send email OTP on success', async () => {
      const result = await userService.requestEmailChange({
        userId: learner._id,
        email: 'newlearner@example.com',
        currentPassword: 'CurrentPassword123!'
      });

      expect(result.requiresVerification).toBe(true);
      expect(result.email).toBe('newlearner@example.com');

      expect(otpService.enforceResendCooldown).toHaveBeenCalledWith({
        userId: learner._id,
        purpose: 'email_change'
      });
      expect(otpService.createOtp).toHaveBeenCalledWith({
        userId: learner._id,
        purpose: 'email_change',
        metadata: { newEmail: 'newlearner@example.com' }
      });
      expect(emailService.sendEmailChangeOtp).toHaveBeenCalledWith({
        to: 'newlearner@example.com',
        otp: '123456',
        name: learner.name
      });
    });

    test('verifyEmailChange should verify OTP, update email, and revoke other sessions', async () => {
      otpService.verifyOtp.mockResolvedValueOnce({ newEmail: 'confirmed@example.com' });

      const result = await userService.verifyEmailChange({
        userId: learner._id,
        payload: { otp: '123456', refreshToken: 'current_token_123' },
        requestMeta: { ip: '127.0.0.1' }
      });

      expect(result.message).toBe('Email changed successfully.');
      expect(result.data.user.email).toBe('confirmed@example.com');

      // Verify MongoDB persistence
      const updated = await User.findById(learner._id);
      expect(updated.email).toBe('confirmed@example.com');
      expect(updated.emailVerified).toBe(true);

      // Verify other sessions revoked
      expect(sessionService.revokeOtherUserSessions).toHaveBeenCalledWith({
        userId: learner._id,
        reason: 'email_changed',
        ip: '127.0.0.1',
        currentRefreshToken: 'current_token_123'
      });
    });

    test('verifyEmailChange should throw 400 OTP_INVALID if metadata contains empty newEmail', async () => {
      otpService.verifyOtp.mockResolvedValueOnce({}); // Missing newEmail

      await expect(userService.verifyEmailChange({
        userId: learner._id,
        payload: { otp: '123456' }
      })).rejects.toThrow('Invalid or expired OTP');
    });

    test('verifyEmailChange should throw 409 EMAIL_ALREADY_EXISTS if email was registered by someone else during OTP verification', async () => {
      otpService.verifyOtp.mockResolvedValueOnce({ newEmail: 'tutor@example.com' });

      await expect(userService.verifyEmailChange({
        userId: learner._id,
        payload: { otp: '123456' }
      })).rejects.toThrow('Email is already registered');
    });
  });

  // =========================================================================
  // 3. PASSWORD CHANGE
  // =========================================================================
  describe('changePassword', () => {
    test('should throw 400 CURRENT_PASSWORD_INVALID when current password does not match', async () => {
      await expect(userService.changePassword({
        userId: learner._id,
        payload: {
          currentPassword: 'IncorrectPassword!',
          newPassword: 'BrandNewPassword123!'
        }
      })).rejects.toThrow('Current password is incorrect');
    });

    test('should update password hash, reset failed login attempts, and revoke all user sessions', async () => {
      await User.findByIdAndUpdate(learner._id, {
        failedLoginAttempts: 3,
        lockUntil: new Date(Date.now() + 60000)
      });

      const result = await userService.changePassword({
        userId: learner._id,
        payload: {
          currentPassword: 'CurrentPassword123!',
          newPassword: 'BrandNewPassword123!'
        },
        requestMeta: { ip: '192.168.1.1' }
      });

      expect(result.message).toBe('Password changed successfully. Please log in again.');

      // Verify MongoDB persistence
      const updated = await User.findById(learner._id).select('+passwordHash');
      expect(updated.failedLoginAttempts).toBe(0);
      expect(updated.lockUntil).toBeNull();
      expect(updated.passwordHash).not.toBe(learner.passwordHash);

      // Verify all sessions revoked
      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith({
        userId: learner._id,
        reason: 'password_changed',
        ip: '192.168.1.1'
      });
    });

    test('should throw 404 USER_NOT_FOUND if user does not exist or is soft-deleted', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      await expect(userService.changePassword({
        userId: nonExistentId,
        payload: { currentPassword: 'test', newPassword: 'test' }
      })).rejects.toThrow('User not found');
    });
  });

  // =========================================================================
  // 4. TUTOR APPROVAL PROFILE MANAGEMENT
  // =========================================================================
  describe('Tutor Approval Profile Management', () => {
    test('getTutorApprovalProfile should throw 403 TUTOR_ACCOUNT_REQUIRED if user is not a tutor', async () => {
      await expect(userService.getTutorApprovalProfile({ userId: learner._id }))
        .rejects.toThrow(ApiError);

      try {
        await userService.getTutorApprovalProfile({ userId: learner._id });
      } catch (err) {
        expect(err.statusCode).toBe(403);
        expect(err.code).toBe('TUTOR_ACCOUNT_REQUIRED');
      }
    });

    test('getTutorApprovalProfile should return default tutor approval profile for tutor', async () => {
      const result = await userService.getTutorApprovalProfile({ userId: tutor._id });

      expect(result.message).toBe('Tutor approval profile retrieved successfully.');
      expect(result.data.tutorApproval).toBeDefined();
      expect(result.data.tutorApproval.credentials).toEqual([]);
      expect(result.data.tutorApproval.expertise).toEqual([]);
    });

    test('getTutorApprovalProfile should hydrate rejection reason from AuditLog if status is rejected', async () => {
      await User.findByIdAndUpdate(tutor._id, { status: 'rejected' });
      await AuditLog.create({
        actorUserId: admin._id,
        targetUserId: tutor._id,
        action: 'REJECT_TUTOR',
        metadata: { reason: 'Incomplete credential documentation' }
      });

      const result = await userService.getTutorApprovalProfile({ userId: tutor._id });

      expect(result.data.tutorApproval.rejectionReason).toBe('Incomplete credential documentation');
    });

    test('updateTutorApprovalProfile should update bio and expertise for tutor', async () => {
      const result = await userService.updateTutorApprovalProfile({
        userId: tutor._id,
        payload: {
          bio: 'Senior Software Engineer & Lead Instructor',
          expertise: ['Node.js', 'MongoDB', 'Docker']
        }
      });

      expect(result.message).toBe('Tutor approval profile updated successfully.');
      expect(result.data.tutorApproval.expertise).toEqual(['Node.js', 'MongoDB', 'Docker']);

      const updated = await User.findById(tutor._id);
      expect(updated.profile.bio).toBe('Senior Software Engineer & Lead Instructor');
      expect(updated.profile.tutorApproval.expertise).toEqual(['Node.js', 'MongoDB', 'Docker']);
    });

    test('updateTutorApprovalProfile should throw 403 TUTOR_ACCOUNT_REQUIRED for non-tutors', async () => {
      await expect(userService.updateTutorApprovalProfile({
        userId: learner._id,
        payload: { expertise: ['Math'] }
      })).rejects.toThrow('Tutor account required');
    });
  });

  // =========================================================================
  // 5. TUTOR CREDENTIALS (AADHAAR)
  // =========================================================================
  describe('Tutor Credential Upload & Deletion', () => {
    test('addTutorCredential should throw 400 MISSING_FILE if no file is uploaded', async () => {
      await expect(userService.addTutorCredential({
        userId: tutor._id,
        files: []
      })).rejects.toThrow('No Aadhaar file uploaded');
    });

    test('addTutorCredential should throw 400 CREDENTIAL_LIMIT_EXCEEDED if more than 1 file uploaded', async () => {
      await expect(userService.addTutorCredential({
        userId: tutor._id,
        files: [{ name: 'aadhaar1.pdf' }, { name: 'aadhaar2.pdf' }]
      })).rejects.toThrow('Only one Aadhaar file can be uploaded');
    });

    test('addTutorCredential should upload file and push to credentials array', async () => {
      const file = { originalname: 'aadhaar.pdf', buffer: Buffer.from('fake-doc') };

      const result = await userService.addTutorCredential({
        userId: tutor._id,
        file
      });

      expect(result.message).toBe('Aadhaar uploaded successfully.');
      expect(result.data.tutorApproval.credentials).toHaveLength(1);
      expect(result.data.tutorApproval.credentials[0].fileUrl).toBe('https://res.cloudinary.com/demo/raw/upload/aadhaar_123.pdf');

      // Verify MongoDB state
      const updated = await User.findById(tutor._id);
      expect(updated.profile.tutorApproval.credentials).toHaveLength(1);
    });

    test('addTutorCredential should throw 400 CREDENTIAL_LIMIT_EXCEEDED if user already has a credential', async () => {
      const file = { originalname: 'aadhaar.pdf', buffer: Buffer.from('fake-doc') };

      // First upload
      await userService.addTutorCredential({ userId: tutor._id, file });

      // Second upload attempt
      await expect(userService.addTutorCredential({ userId: tutor._id, file }))
        .rejects.toThrow('Only one Aadhaar file can be uploaded');
    });

    test('removeTutorCredential should delete resource from storage and remove from profile', async () => {
      const file = { originalname: 'aadhaar.pdf', buffer: Buffer.from('fake-doc') };
      const uploadRes = await userService.addTutorCredential({ userId: tutor._id, file });
      const credentialId = uploadRes.data.tutorApproval.credentials[0]._id;

      const deleteRes = await userService.removeTutorCredential({
        userId: tutor._id,
        credentialId
      });

      expect(deleteRes.message).toBe('Aadhaar removed successfully.');
      expect(storageService.deleteResource).toHaveBeenCalledWith({
        publicId: 'raw/aadhaar_123',
        resourceType: 'raw'
      });

      const updated = await User.findById(tutor._id);
      expect(updated.profile.tutorApproval.credentials).toHaveLength(0);
    });

    test('removeTutorCredential should throw 404 CREDENTIAL_NOT_FOUND for non-existent credential ID', async () => {
      const nonExistentCredId = new mongoose.Types.ObjectId();
      await expect(userService.removeTutorCredential({
        userId: tutor._id,
        credentialId: nonExistentCredId
      })).rejects.toThrow('Aadhaar file not found');
    });
  });

  // =========================================================================
  // 6. TUTOR SAMPLE VIDEO (CLOUDINARY & MUX)
  // =========================================================================
  describe('Tutor Sample Video Management', () => {
    test('uploadTutorSample should throw 400 MISSING_FILE if file is missing', async () => {
      await expect(userService.uploadTutorSample({ userId: tutor._id, file: null }))
        .rejects.toThrow('No sample video uploaded');
    });

    test('uploadTutorSample should upload video and delete previous video if one existed', async () => {
      // First video upload
      await userService.uploadTutorSample({
        userId: tutor._id,
        file: { originalname: 'first_video.mp4', buffer: Buffer.from('video-1') }
      });

      // Second video upload should replace and delete previous
      storageService.uploadTutorSampleVideo.mockResolvedValueOnce({
        videoUrl: 'https://res.cloudinary.com/demo/video/upload/sample_456.mp4',
        publicId: 'video/sample_456',
        resourceType: 'video',
        videoStatus: 'ready'
      });

      const result = await userService.uploadTutorSample({
        userId: tutor._id,
        file: { originalname: 'second_video.mp4', buffer: Buffer.from('video-2') }
      });

      expect(result.message).toBe('Sample video uploaded successfully.');
      expect(result.data.tutorApproval.sampleVideo.videoUrl).toBe('https://res.cloudinary.com/demo/video/upload/sample_456.mp4');

      // Verify deletion of previous video
      expect(storageService.deleteResource).toHaveBeenCalledWith({
        publicId: 'video/sample_123',
        resourceType: 'video'
      });
    });

    test('initTutorSampleVideoMuxUpload should create direct upload session on Mux and save metadata', async () => {
      const result = await userService.initTutorSampleVideoMuxUpload({
        userId: tutor._id,
        payload: { fileName: 'sample.mov', fileSize: 50000000, mimeType: 'video/quicktime' }
      });

      expect(result.message).toBe('Mux sample video upload initialized.');
      expect(result.data.uploadUrl).toBe('https://upload.mux.com/direct/123');
      expect(result.data.uploadId).toBe('mux_upload_id_123');

      const updated = await User.findById(tutor._id);
      expect(updated.profile.tutorApproval.sampleVideo.resourceType).toBe('mux');
      expect(updated.profile.tutorApproval.sampleVideo.videoStatus).toBe('uploading');
    });

    test('getTutorSampleVideoMuxStatus should throw 403 MUX_UPLOAD_FORBIDDEN if uploadId does not match tutor session', async () => {
      await userService.initTutorSampleVideoMuxUpload({
        userId: tutor._id,
        payload: { fileName: 'sample.mp4' }
      });

      await expect(userService.getTutorSampleVideoMuxStatus({
        userId: tutor._id,
        uploadId: 'foreign_upload_id_999'
      })).rejects.toThrow('Upload session does not belong to this tutor application');
    });

    test('getTutorSampleVideoMuxStatus should query Mux, set ready status and playback URL when asset is created', async () => {
      await userService.initTutorSampleVideoMuxUpload({
        userId: tutor._id,
        payload: { fileName: 'sample.mp4' }
      });

      const result = await userService.getTutorSampleVideoMuxStatus({
        userId: tutor._id,
        uploadId: 'mux_upload_id_123'
      });

      expect(result.message).toBe('Mux sample video status retrieved.');
      expect(result.data.status).toBe('ready');
      expect(result.data.playbackId).toBe('playback_id_123');
      expect(result.data.videoUrl).toBe('https://stream.mux.com/playback_id_123.m3u8');

      const updated = await User.findById(tutor._id);
      expect(updated.profile.tutorApproval.sampleVideo.videoStatus).toBe('ready');
      expect(updated.profile.tutorApproval.sampleVideo.muxPlaybackId).toBe('playback_id_123');
    });

    test('getTutorSampleVideoMuxStatus should update videoStatus to failed when Mux status is errored', async () => {
      await userService.initTutorSampleVideoMuxUpload({
        userId: tutor._id,
        payload: { fileName: 'sample.mp4' }
      });

      muxService.getUploadStatus.mockResolvedValueOnce({
        status: 'errored'
      });

      await userService.getTutorSampleVideoMuxStatus({
        userId: tutor._id,
        uploadId: 'mux_upload_id_123'
      });

      const updated = await User.findById(tutor._id);
      expect(updated.profile.tutorApproval.sampleVideo.videoStatus).toBe('failed');
    });
  });

  // =========================================================================
  // 7. RESUBMIT TUTOR APPROVAL & STATE TRANSITIONS
  // =========================================================================
  describe('resubmitTutorApproval', () => {
    test('should throw 400 TUTOR_APPROVAL_INCOMPLETE if bio, Aadhaar, or sample video are missing', async () => {
      // Missing credentials & video
      await expect(userService.resubmitTutorApproval({ userId: tutor._id }))
        .rejects.toThrow(ApiError);

      try {
        await userService.resubmitTutorApproval({ userId: tutor._id });
      } catch (err) {
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('TUTOR_APPROVAL_INCOMPLETE');
      }
    });

    test('should transition user status to pending_approval and update InstitutionMembership if linked', async () => {
      const institutionId = new mongoose.Types.ObjectId();
      await User.findByIdAndUpdate(tutor._id, {
        institutionId,
        status: 'rejected',
        'profile.bio': 'Qualified instructor',
        'profile.tutorApproval.credentials': [{
          fileUrl: 'https://res.cloudinary.com/demo/raw/aadhaar.pdf',
          title: 'aadhaar.pdf'
        }],
        'profile.tutorApproval.sampleVideo': {
          videoUrl: 'https://stream.mux.com/sample.m3u8'
        }
      });

      const membership = await InstitutionMembership.create({
        userId: tutor._id,
        institutionId,
        memberType: 'tutor',
        status: 'suspended'
      });

      const result = await userService.resubmitTutorApproval({ userId: tutor._id });

      expect(result.message).toBe('Tutor application submitted for review.');
      expect(result.data.user.status).toBe('pending_approval');
      expect(result.data.tutorApproval.rejectionReason).toBe('');

      // Verify User state
      const updatedUser = await User.findById(tutor._id);
      expect(updatedUser.status).toBe('pending_approval');

      // Verify InstitutionMembership state
      const updatedMembership = await InstitutionMembership.findById(membership._id);
      expect(updatedMembership.status).toBe('pending_approval');
    });
  });

  // =========================================================================
  // 8. NOTIFICATION SETTINGS
  // =========================================================================
  describe('Notification Settings', () => {
    test('getNotificationSettings should return user notification settings', async () => {
      const result = await userService.getNotificationSettings({ userId: learner._id });

      expect(result.message).toBe('Notification settings retrieved successfully.');
      expect(result.data.notificationSettings).toBeDefined();
    });

    test('updateNotificationSettings should update email and inApp preferences for valid types', async () => {
      const payload = {
        enrollmentConfirmed: { email: false, inApp: true },
        newLesson: { email: true, inApp: false }
      };

      const result = await userService.updateNotificationSettings({
        userId: learner._id,
        payload
      });

      expect(result.message).toBe('Notification settings updated successfully.');
      expect(result.data.notificationSettings.enrollmentConfirmed.email).toBe(false);
      expect(result.data.notificationSettings.enrollmentConfirmed.inApp).toBe(true);
      expect(result.data.notificationSettings.newLesson.email).toBe(true);
      expect(result.data.notificationSettings.newLesson.inApp).toBe(false);

      const updated = await User.findById(learner._id);
      expect(updated.notificationSettings.enrollmentConfirmed.email).toBe(false);
    });

    test('getNotificationSettings and updateNotificationSettings should throw 404 for non-existent user', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      await expect(userService.getNotificationSettings({ userId: nonExistentId }))
        .rejects.toThrow('User not found');
      await expect(userService.updateNotificationSettings({ userId: nonExistentId, payload: {} }))
        .rejects.toThrow('User not found');
    });
  });
});
