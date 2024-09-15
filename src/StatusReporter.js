import { uploadJsonToS3, getDiskUsage } from './utils.js';

export async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// For small logs
export class StatusReporter {
  constructor(bucket, key) {
    this.bucket = bucket;
    this.key = key;
    this.logs = [];
    this.memoryInterval = null;
    this.uploadInterval = null;
    this.uploading = false;
    this.lastUploadLen = 0;
  }

  startMemoryLogs(timeout) {
    if (this.memoryInterval) throw new Error('ALREADY_LOGGING_MEMORY');
    this.memoryInterval = setInterval(async () => {
      this.log('Memory Usage Update', {
        memory: process.memoryUsage(),
        disk: await getDiskUsage(),
      });
    }, timeout);
  }

  stopMemoryLogs() {
    if (this.memoryInterval) {
      clearInterval(this.memoryInterval);
      this.memoryInterval = null;
    }
  }

  startUploading(timeout) {
    if (this.uploading) throw new Error('ALREADY_UPLOADING');
    this.uploading = true;
    this.uploadInterval = setInterval(async () => {
      if(!this.uploading) {
        clearInterval(this.uploadInterval);
      }
      if(this.logs.length > this.lastUploadLen) {
        this.lastUploadLen = this.logs.length;
        await uploadJsonToS3(this.bucket, this.key, this.logs);
      }
      // After upload finishes, so it's safe to quit
      if(!this.uploading) {
        this.uploadInterval = null;
      }
    }, timeout);
  }

  async stopUploading() {
    this.uploading = false;
    while(this.uploadInterval !== null) {
      await delay(1000);
    }
  }

  log(msg, data) {
    // Add log entry
    this.logs.push({
      msg,
      data,
      time: process.uptime(),
    });
  }

}

