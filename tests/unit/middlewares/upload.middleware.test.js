const {
  uploadAvatar,
  uploadThumbnail,
  uploadAttachment,
  uploadSubtitle,
  uploadSubmission,
  uploadTutorCredential,
  uploadTutorSampleVideo,
  uploadCsv
} = require('../../../src/middlewares/upload.middleware');
const { ApiError } = require('../../../src/utils/errors');

describe('Upload Middleware Unit Tests (File Filters)', () => {
  describe('uploadAvatar filter', () => {
    test('should accept valid image mime type', (done) => {
      const filter = uploadAvatar.fileFilter;
      filter({}, { mimetype: 'image/png' }, (err, result) => {
        expect(err).toBeNull();
        expect(result).toBe(true);
        done();
      });
    });

    test('should reject invalid avatar mime type with 400 INVALID_AVATAR_TYPE', (done) => {
      const filter = uploadAvatar.fileFilter;
      filter({}, { mimetype: 'application/pdf' }, (err) => {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('INVALID_AVATAR_TYPE');
        done();
      });
    });
  });

  describe('uploadThumbnail filter', () => {
    test('should accept valid thumbnail mime type', (done) => {
      const filter = uploadThumbnail.fileFilter;
      filter({}, { mimetype: 'image/jpeg' }, (err, result) => {
        expect(err).toBeNull();
        expect(result).toBe(true);
        done();
      });
    });

    test('should reject invalid thumbnail mime type', (done) => {
      const filter = uploadThumbnail.fileFilter;
      filter({}, { mimetype: 'video/mp4' }, (err) => {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('INVALID_THUMBNAIL_TYPE');
        done();
      });
    });
  });

  describe('uploadAttachment filter', () => {
    test('should accept PDF, DOC, and DOCX files', (done) => {
      const filter = uploadAttachment.fileFilter;
      filter({}, { originalname: 'document.pdf', mimetype: 'application/pdf' }, (err, result) => {
        expect(err).toBeNull();
        expect(result).toBe(true);
        done();
      });
    });

    test('should reject unsupported attachment format', (done) => {
      const filter = uploadAttachment.fileFilter;
      filter({}, { originalname: 'script.js', mimetype: 'application/javascript' }, (err) => {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('INVALID_ATTACHMENT_TYPE');
        done();
      });
    });
  });

  describe('uploadSubtitle filter', () => {
    test('should accept VTT and SRT files', (done) => {
      const filter = uploadSubtitle.fileFilter;
      filter({}, { originalname: 'subtitles.vtt', mimetype: 'text/vtt' }, (err, result) => {
        expect(err).toBeNull();
        expect(result).toBe(true);
        done();
      });
    });

    test('should reject invalid subtitle file type', (done) => {
      const filter = uploadSubtitle.fileFilter;
      filter({}, { originalname: 'subtitles.mp3', mimetype: 'audio/mp3' }, (err) => {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('INVALID_SUBTITLE_TYPE');
        done();
      });
    });
  });

  describe('uploadSubmission filter', () => {
    test('should reject executable file uploads (.exe, .js, .sh)', (done) => {
      const filter = uploadSubmission.fileFilter;
      filter({}, { originalname: 'malware.exe', mimetype: 'application/octet-stream' }, (err) => {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('INVALID_FILE_TYPE');
        done();
      });
    });
  });

  describe('uploadTutorCredential filter', () => {
    test('should accept PDF credential files', (done) => {
      const filter = uploadTutorCredential.fileFilter;
      filter({}, { originalname: 'aadhaar.pdf', mimetype: 'application/pdf' }, (err, result) => {
        expect(err).toBeNull();
        expect(result).toBe(true);
        done();
      });
    });

    test('should reject non-credential file formats', (done) => {
      const filter = uploadTutorCredential.fileFilter;
      filter({}, { originalname: 'video.mp4', mimetype: 'video/mp4' }, (err) => {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('INVALID_CREDENTIAL_TYPE');
        done();
      });
    });
  });

  describe('uploadTutorSampleVideo filter', () => {
    test('should accept MP4 video files', (done) => {
      const filter = uploadTutorSampleVideo.fileFilter;
      filter({}, { originalname: 'intro.mp4', mimetype: 'video/mp4' }, (err, result) => {
        expect(err).toBeNull();
        expect(result).toBe(true);
        done();
      });
    });

    test('should reject non-video files', (done) => {
      const filter = uploadTutorSampleVideo.fileFilter;
      filter({}, { originalname: 'intro.pdf', mimetype: 'application/pdf' }, (err) => {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('INVALID_SAMPLE_VIDEO_TYPE');
        done();
      });
    });
  });

  describe('uploadCsv filter', () => {
    test('should accept valid CSV file', (done) => {
      const filter = uploadCsv.fileFilter;
      filter({}, { originalname: 'students.csv', mimetype: 'text/csv' }, (err, result) => {
        expect(err).toBeNull();
        expect(result).toBe(true);
        done();
      });
    });

    test('should reject non-CSV file', (done) => {
      const filter = uploadCsv.fileFilter;
      filter({}, { originalname: 'students.json', mimetype: 'application/json' }, (err) => {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('INVALID_CSV_TYPE');
        done();
      });
    });
  });
});
