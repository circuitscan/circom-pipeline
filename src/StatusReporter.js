import {uploadJsonToS3, getDiskUsage} from './utils.js';

// For small logs
export class StatusReporter {
  constructor(bucket, key) {
    this.bucket = bucket;
    this.key = key;
    this.logs = [];
    this.memoryInterval = null;
  }
  startMemoryLogs(timeout) {
    if(this.memoryInterval) throw new Error('ALREADY_LOGGING_MEMORY');
    this.memoryInterval = setInterval(async () => {
      this.log('Memory Usage Update', {
        memory: process.memoryUsage(),
        disk: await getDiskUsage(),
      });
    }, timeout);
  }
  stopMemoryLogs() {
    if(this.memoryInterval) {
      clearInterval(this.memoryInterval);
      this.memoryInterval = null;
    }
  }
  async log(msg, data) {
    this.logs.push({
      msg,
      data,
      time: process.uptime(),
    });
    await uploadJsonToS3(this.bucket, this.key, this.logs);
  }
}
