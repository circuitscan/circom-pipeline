
export class MockStatusReporter {
  constructor() {
    this.logs = [];
  }

  log(msg, data) {
    this.logs.push({
      msg,
      data,
      time: process.uptime(),
    });
  }
}
