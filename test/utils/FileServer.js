import http from 'http';
import https from 'https';
import { readFile } from 'fs/promises';
import pem from 'pem';

export class FileServer {
  constructor(filename, useHttps = false) {
    this.filename = filename;
    this.useHttps = useHttps;
    this.privateKey = null;
    this.certificate = null;
  }

  async setupHttpsCredentials() {
    const self = this;
    return new Promise((resolve, reject) => {
      pem.createCertificate({ days: 1, selfSigned: true }, function (err, keys) {
        if (err) {
          reject(err);
        } else {
          self.privateKey = keys.serviceKey;
          self.certificate = keys.certificate;
          resolve();
        }
      });
    });
  }

  async start() {
    return new Promise(async (resolve, reject) => {
      let server;
      const requestHandler = async (req, res) => {
        if (req.method === 'GET') {
          try {
            const data = await readFile(this.filename);
            res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
            res.end(data);
          } catch (err) {
            console.error('Error reading the file:', err);
            res.writeHead(500);
            res.end('Server error');
          }
        } else {
          res.writeHead(405);
          res.end('Method Not Allowed');
        }
      };

      if (this.useHttps) {
        await this.setupHttpsCredentials();
        const serverOptions = {
          key: this.privateKey,
          cert: this.certificate
        };
        server = https.createServer(serverOptions, requestHandler);
      } else {
        server = http.createServer(requestHandler);
      }

      server.listen(0, () => {
        const port = server.address().port;
        this.server = server;  // Store the server instance for potential later reference
        resolve(port);
      });

      server.on('error', (err) => {
        reject(err);
      });
    });
  }
}
