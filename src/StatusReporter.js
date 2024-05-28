import {uploadJsonToS3} from './utils.js';

// For small logs
export class StatusReporter {
  constructor(bucket, key) {
    this.bucket = bucket;
    this.key = key;
    this.logs = [];
  }
  async log(msg) {
    this.logs.push({
      msg,
      time: process.uptime(),
    });
    uploadJsonToS3(this.bucket, this.key, this.logs);
  }
}
