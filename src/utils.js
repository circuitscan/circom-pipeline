import https from 'node:https';
import {mkdirSync, createWriteStream, createReadStream} from 'node:fs';
import {isAbsolute, resolve, sep} from 'node:path';
import {exec} from 'node:child_process';

import {S3Client, PutObjectCommand} from '@aws-sdk/client-s3';
import {Upload} from '@aws-sdk/lib-storage';
import archiver from 'archiver';

const s3Client = new S3Client({
  // use alternate env var names for lambda compatibility
  region: process.env.BB_REGION,
  credentials: {
    accessKeyId: process.env.BB_ACCESS_KEY_ID,
    secretAccessKey: process.env.BB_SECRET_ACCESS_KEY,
  },
  endpoint: process.env.BB_ENDPOINT,
});

export function executeCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        return reject(error);
      }
      console.log(`stdout: ${stdout}`);
      console.error(`stderr: ${stderr}`);
      resolve(stdout ? stdout : stderr);
    });
  });
}

export function getDiskUsage() {
  return new Promise((resolve, reject) => {
    exec('df', (error, stdout, stderr) => {
      if (error) {
        reject(`Error executing 'df': ${error.message}`);
        return;
      }
      if (stderr) {
        reject(`stderr: ${stderr}`);
        return;
      }
      resolve(parseDfOutput(stdout));
    });
  });
}

/**
 * Finds a process by name and invokes a callback with updates about its memory usage every 10 seconds.
 * @param {string} processName - The name of the process to monitor.
 * @param {number} timeout - Milliseconds to wait between checking.
 * @param {function} callback - The callback function to invoke with memory usage updates.
 */
export function monitorProcessMemory(processName, timeout, callback) {
    function getMemoryUsage() {
        exec(`ps aux | grep ${processName} | grep -v grep | awk '{sum += $6} END {print sum}'`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error executing command: ${error.message}`);
                return;
            }
            if (stderr) {
                console.error(`stderr: ${stderr}`);
                return;
            }

            const memoryUsage = parseInt(stdout.trim(), 10);
            if (isNaN(memoryUsage)) {
                console.log(`Process ${processName} not found.`);
                return;
            }

            callback(memoryUsage);
            setTimeout(getMemoryUsage, timeout);
        });
    }

    setTimeout(getMemoryUsage, timeout);
}

function parseDfOutput(dfOutput) {
  // Split the output into lines
  const lines = dfOutput.trim().split('\n');

  // The first line contains the headers
  const headers = lines[0].trim().split(/\s+/);

  // The rest of the lines contain the data
  const dataLines = lines.slice(1);

  // Create an array to hold the final JSON objects
  const jsonOutput = dataLines.map(line => {
    const columns = line.trim().split(/\s+/);

    // Create an object with header names as keys and corresponding columns as values
    let obj = {};
    headers.forEach((header, index) => {
      obj[header] = columns[index];
    });

    return obj;
  });

  return jsonOutput;
}

export function downloadBinaryFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(outputPath);
    const request = https.get(url, {
      agent: new https.Agent({
        rejectUnauthorized: !url.startsWith('https://localhost:') // This allows self-signed certificates
      }),
    }, response => {
      // Check if the request was successful
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download file: Status code ${response.statusCode}`));
        return;
      }

      // Pipe the response stream directly into the file stream
      response.pipe(file);
    });

    file.on('finish', () => {
      file.close();
      resolve(`File downloaded and saved to ${outputPath}`);
    });

    // Handle request errors
    request.on('error', err => {
      file.close();
      reject(err);
    });

    file.on('error', err => {
      file.close();
      // Attempt to delete the file in case of any error while writing to the stream
      unlink(outputPath, () => reject(err));
    });
  });
}

export async function uploadJsonToS3(bucketName, key, jsonObject) {
  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: JSON.stringify(jsonObject),
    ContentType: 'application/json'
  }));
}

export async function uploadLargeFileToS3(keyName, filePath) {
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: process.env.BLOB_BUCKET,
      Key: keyName,
      Body: createReadStream(filePath),
    },
  });

  // Monitor progress
  upload.on('httpUploadProgress', (progress) => {
    console.log(`Uploaded ${progress.loaded} of ${progress.total} bytes`);
  });

  // Execute the upload
  const result = await upload.done();
  console.log('Upload complete:', result);
}

export function zipDirectory(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outPath);
    const archive = archiver('zip', {
      zlib: { level: 9 } // Sets the compression level.
    });

    output.on('close', function() {
      console.log(archive.pointer() + ' total bytes');
      console.log('archiver has been finalized and the output file descriptor has closed.');
      resolve();
    });

    archive.on('error', function(err) {
      reject(err);
    });

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

export function mkdirpSync(targetDir) {
  const initDir = isAbsolute(targetDir) ? sep : '';
  const baseDir = '.';

  targetDir.split(sep).reduce((parentDir, childDir) => {
    const curDir = resolve(baseDir, parentDir, childDir);
    try {
      mkdirSync(curDir);
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
    }

    return curDir;
  }, initDir);
}
