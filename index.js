import https from 'node:https';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  createWriteStream,
  createReadStream,
} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join, isAbsolute, resolve, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {exec} from 'node:child_process';

import {S3Client, PutObjectCommand} from '@aws-sdk/client-s3';
import {Upload} from '@aws-sdk/lib-storage';
import archiver from 'archiver';
import {Circomkit} from 'circomkit';
import {getPtauName} from 'circomkit/dist/utils/ptau.js';
import * as snarkjs from 'snarkjs';
import { uniqueNamesGenerator, adjectives, colors, animals } from 'unique-names-generator';

export const BUILD_NAME = 'verify_circuit';
const HARDHAT_IMPORT = 'import "hardhat/console.sol";';

const s3Client = new S3Client({
  endpoint: process.env.AWS_ENDPOINT,
});

export async function handler(event) {
  if('body' in event) {
    // Running on AWS
    event = JSON.parse(event.body);
  }
  try {
    switch(event.payload.action) {
      case 'build':
        return await build(event);
      default:
        throw new Error('invalid_command');
    }
  } catch(error) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        errorType: 'error',
        errorMessage: error.message
      }),
    };
  }
}

async function build(event) {
  // TODO validate inputs for better error msgs
  const circuitName = event.payload.circuit.template.toLowerCase();

  const pkgName = `${circuitName}-${uniqueNamesGenerator({
    dictionaries: [adjectives, colors, animals],
    separator: '-',
  })}`;

  const dirPtau = tmpdir();
  const dirPkg = join(tmpdir(), pkgName);
  const dirCircuits = join(dirPkg, 'circuits');
  const dirBuild = join(dirPkg, 'build');
  mkdirSync(dirPkg);
  mkdirSync(dirCircuits);
  mkdirSync(dirBuild);

  for(let file of Object.keys(event.payload.files)) {
    mkdirpSync(dirname(join(dirCircuits, file)));
    writeFileSync(join(dirCircuits, file), event.payload.files[file].code);
  }

  const config = {
    dirCircuits,
    dirPtau,
    dirBuild,
    circomPath: event.payload.circomPath,
    protocol: event.payload.protocol,
  };

  // Export to package
  writeFileSync(join(dirPkg, 'circomkit.json'), JSON.stringify({
    ...config,
    circuits: './circuits.json',
    dirPtau: undefined,
    dirBuild: './build',
    dirCircuits: undefined,
  }, null, 2));

  const circomkit = new Circomkit(config);

  // Export to package
  writeFileSync(join(dirPkg, 'circuits.json'), JSON.stringify({
    [circuitName]: event.payload.circuit,
  }, null, 2));
  await circomkit.compile(BUILD_NAME, event.payload.circuit);

  if(config.protocol === 'groth16' && event.payload.finalZkey) {
    // Using supplied setup
    const {constraints} = await circomkit.info(BUILD_NAME);
    const ptauName = getPtauName(constraints);
    const pkeyPath = join(dirBuild, BUILD_NAME, 'groth16_pkey.zkey');
    let pkeyData;
    if(event.payload.finalZkey.startsWith('https')) {
      // Large zkeys fetched over HTTP
      await downloadBinaryFile(event.payload.finalZkey, pkeyPath);
    } else {
      // Small ones can be sent base64 encoded
      pkeyData = Buffer.from(event.payload.finalZkey, 'base64');
      writeFileSync(pkeyPath, pkeyData);
    }
    // Verify the setup
    const result = await snarkjs.zKey.verifyFromR1cs(
      join(dirBuild, BUILD_NAME, BUILD_NAME + '.r1cs'),
      join(dirPtau, ptauName),
      pkeyPath,
    );
    if(!result) throw new Error('INVALID_ZKEY');
  } else {
    await circomkit.setup(BUILD_NAME);
  }
  await circomkit.vkey(BUILD_NAME);

  // TODO: plonk output has an errant hardhat debug include
  // https://github.com/iden3/snarkjs/pull/464
  const contractPath = await circomkit.contract(BUILD_NAME);
  let solidityCode = readFileSync(contractPath, {encoding: 'utf8'});
  if(solidityCode.indexOf(HARDHAT_IMPORT) > -1) {
    solidityCode = solidityCode.replace(HARDHAT_IMPORT, '');
    writeFileSync(contractPath, solidityCode);
  }

  const wasmPath = join('build', BUILD_NAME, BUILD_NAME + '_js', BUILD_NAME + '.wasm');
  const pkeyPath = join('build', BUILD_NAME, event.payload.protocol + '_pkey.zkey');
  const vkeyPath = join('build', BUILD_NAME, event.payload.protocol + '_vkey.json');
  const vkey = readFileSync(join(dirPkg, vkeyPath), {encoding: 'utf8'});

  // Include Javascript to generate and verify proofs
  const thisdir = dirname(fileURLToPath(import.meta.url));
  const templates = [ 'index.js', 'package.json', 'README.md' ];
  for(let template of templates) {
    const content = readFileSync(join(thisdir, 'template', template), {encoding: 'utf8'})
      .replaceAll('%%package_name%%', pkgName)
      .replaceAll('%%circuit_name%%', circuitName)
      .replaceAll('%%protocol%%', event.payload.protocol)
      .replaceAll('%%wasm_path%%', wasmPath)
      .replaceAll('%%pkey_path%%', pkeyPath)
      .replaceAll('%%vkey%%', vkey);
    writeFileSync(join(dirPkg, template), content);
  }

  // Circom sources to S3
  await zipDirectory(dirCircuits, dirPkg + '-source.zip');
  await uploadLargeFileToS3(pkgName + '/source.zip', dirPkg + '-source.zip');
  // Solidity verifier to s3
  await uploadLargeFileToS3(pkgName + '/verifier.sol', contractPath);
  // Entire package to s3
  await zipDirectory(dirPkg, dirPkg + '.zip');
  await uploadLargeFileToS3(pkgName + '/pkg.zip', dirPkg + '.zip');

  return {
    statusCode: 200,
    body: JSON.stringify({
      pkgName,
    }),
  };
}

function executeCommand(command) {
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

function downloadBinaryFile(url, outputPath) {
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

async function uploadLargeFileToS3(keyName, filePath) {
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

function zipDirectory(sourceDir, outPath) {
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
    archive.directory(sourceDir);
    archive.finalize();
  });
}

function mkdirpSync(targetDir) {
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
