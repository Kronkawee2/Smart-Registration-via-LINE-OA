const { Storage } = require('@google-cloud/storage');
const path = require('path');

/**
 * Note: The GCS bucket must be configured with an Object Lifecycle Management policy
 * to automatically delete objects older than 7 days, to comply with our PHI data retention policy.
 * Example gsutil command:
 * gsutil lifecycle set lifecycle.json gs://YOUR_BUCKET_NAME
 */

class StorageService {
  constructor() {
    this.storage = new Storage();
    this.bucketName = process.env.GCP_STORAGE_BUCKET_NAME;
  }

  /**
   * Uploads a buffer to GCS and returns the public or signed URL.
   * @param {Buffer} buffer - The image buffer to upload.
   * @param {string} originalFileName - The original file name or message ID.
   * @returns {Promise<string>} The Signed URL of the uploaded image.
   */
  async uploadImageBuffer(buffer, originalFileName) {
    if (!this.bucketName) {
        throw new Error('GCP_STORAGE_BUCKET_NAME is not defined');
    }

    const bucket = this.storage.bucket(this.bucketName);
    const fileName = `images/${Date.now()}_${originalFileName}.jpg`;
    const file = bucket.file(fileName);

    await file.save(buffer, {
      metadata: {
        contentType: 'image/jpeg',
      },
    });

    // Generate a Signed URL that expires in 15 minutes (to keep PHI secure)
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
    });

    return url;
  }
}

module.exports = new StorageService();
