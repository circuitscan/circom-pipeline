import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  statSync,
  renameSync,
  rmSync,
} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';

import {Circomkit} from 'circomkit';
import { uniqueNamesGenerator, adjectives, colors, animals } from 'unique-names-generator';

import {
  executeCommand,
  downloadBinaryFile,
  uploadLargeFileToS3,
  zipDirectory,
  mkdirpSync,
  monitorProcessMemory,
} from './utils.js';
import {StatusReporter} from './StatusReporter.js';
import {
  SNARKJS_VERSIONS,
  CIRCOM_VERSIONS,
} from './deps.js';

export const BUILD_NAME = 'verify_circuit';
const HARDHAT_IMPORT = 'import "hardhat/console.sol";';

export async function build(event) {
  if(!/^[a-zA-Z0-9]{6,40}$/.test(event.payload.requestId))
    throw new Error('invalid_requestId');
  const circuitName = event.payload.circuit.template.toLowerCase();
  const snarkjsVersion = event.payload.snarkjsVersion || SNARKJS_VERSIONS[0];
  if(SNARKJS_VERSIONS.indexOf(snarkjsVersion) === -1)
    throw new Error('invalid_snarkjs_version');
  const snarkjsPkgName = `snarkjs-v${snarkjsVersion}`;
  const snarkjs = await import(snarkjsPkgName);
  if(['groth16', 'fflonk', 'plonk'].indexOf(event.payload.protocol) === -1)
    throw new Error('invalid_protocol');
  if(typeof event.payload.files !== 'object')
    throw new Error('invalid_files');
  if(!event.payload.circomPath
      || !event.payload.circomPath.startsWith('circom-v')
      || CIRCOM_VERSIONS.indexOf(event.payload.circomPath.slice(8)) === -1)
    throw new Error('invalid_circomPath')
  if(typeof event.payload.circuit !== 'object')
    throw new Error('invalid_circuit');

  const pkgName = `${circuitName}-${uniqueNamesGenerator({
    dictionaries: [adjectives, colors, animals],
    separator: '-',
  })}`;
  const status = new StatusReporter(process.env.BLOB_BUCKET, `status/${event.payload.requestId}.json`);
  await status.log(`Compiling ${pkgName}...`);

  // Be sure to put error messages in the status log
  try {
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
      verbose: true,
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
    // Redirect logs to status
    circomkit.log = async (msg) => {
      await status.log('Circomkit Log', { msg });
    };
    const wasmPath = join('build', BUILD_NAME, BUILD_NAME + '_js', BUILD_NAME + '.wasm');
    const pkeyPath = join('build', BUILD_NAME, event.payload.protocol + '_pkey.zkey');
    const fullPkeyPath = join(dirPkg, pkeyPath);
    const vkeyPath = join('build', BUILD_NAME, event.payload.protocol + '_vkey.json');
    const r1csPath = join(dirBuild, BUILD_NAME, BUILD_NAME + '.r1cs');
    const contractPath = join(dirBuild, BUILD_NAME, event.payload.protocol + '_verifier.sol');

    // Export to package
    writeFileSync(join(dirPkg, 'circuits.json'), JSON.stringify({
      [circuitName]: event.payload.circuit,
    }, null, 2));
    const compilePromise = circomkit.compile(BUILD_NAME, event.payload.circuit);
    monitorProcessMemory(event.payload.circomPath, 10000, async (memoryUsage) => {
      await status.log(`Circom memory usage`, { memoryUsage });
    });
    await compilePromise;
    status.startMemoryLogs(10000);
    await status.log(`Downloading PTAU...`);
    const ptauPath = await circomkit.ptau(BUILD_NAME);

    if(config.protocol === 'groth16' && event.payload.finalZkey) {
      // Using supplied setup
      let pkeyData;
      if(event.payload.finalZkey.startsWith('https')) {
        // Large zkeys fetched over HTTP
        await status.log(`Downloading finalZkey...`);
        await downloadBinaryFile(event.payload.finalZkey, fullPkeyPath);
      } else {
        // Small ones can be sent base64 encoded
        pkeyData = Buffer.from(event.payload.finalZkey, 'base64');
        writeFileSync(fullPkeyPath, pkeyData);
      }
      // Verify the setup
      await status.log(`Verifying finalZkey...`);
      const result = await snarkjs.zKey.verifyFromR1cs(
        join(dirBuild, BUILD_NAME, BUILD_NAME + '.r1cs'),
        ptauPath,
        fullPkeyPath,
      );
      if(!result) {
        await status.log(`Invalid finalZkey!`);
        throw new Error('invalid_zkey');
      }
    } else {
      // This section adapted from circomkit so it can run using custom snarkjs version
      if(event.payload.protocol === 'groth16') {
        // Groth16 needs a circuit specific setup
        await status.log(`Groth16 setup with random entropy...`);

        // generate genesis zKey
        let curZkey = join(dirBuild, BUILD_NAME, 'step0.zkey');
        await snarkjs.zKey.newZKey(r1csPath, ptauPath, curZkey);

        // make contributions
        // XXX does one random contribution
        for (let contrib = 1; contrib <= 1; contrib++) {
          const nextZkey = join(dirBuild, BUILD_NAME, `step${contrib}.zkey`);

          await snarkjs.zKey.contribute(
            curZkey,
            nextZkey,
            `${BUILD_NAME}_${contrib}`,
            randomBytes(32), // entropy
          );

          // remove current key, and move on to next one
          rmSync(curZkey);
          curZkey = nextZkey;
        }

        // finally, rename the resulting key to pkey
        renameSync(curZkey, fullPkeyPath);
      } else {
        await status.log(`Circuit setup...`);
        // PLONK or FFLONK don't need specific setup
        await snarkjs[event.payload.protocol].setup(r1csPath, ptauPath, fullPkeyPath);
      }
    }

    // export verification key
    await status.log(`Exporting verification key and solidity verifier...`);
    const vkey = JSON.stringify(await snarkjs.zKey.exportVerificationKey(fullPkeyPath), null, 2);
    writeFileSync(join(dirPkg, vkeyPath), vkey);

    // Export solidity verifier
    const template = readFileSync(`./node_modules/${snarkjsPkgName}/templates/verifier_${event.payload.protocol}.sol.ejs`, 'utf-8');

    let contractCode = await snarkjs.zKey.exportSolidityVerifier(
      fullPkeyPath,
      {[event.payload.protocol]: template},
    );

    // TODO: plonk output has an errant hardhat debug include
    // https://github.com/iden3/snarkjs/pull/464
    if(contractCode.indexOf(HARDHAT_IMPORT) > -1) {
      contractCode = contractCode.replace(HARDHAT_IMPORT, '');
    }

    writeFileSync(contractPath, contractCode);

    await status.log(`Storing build artifacts...`);
    // Include Javascript to generate and verify proofs
    const thisdir = dirname(fileURLToPath(import.meta.url));
    const templates = [ 'index.js', 'package.json', 'README.md' ];
    for(let template of templates) {
      const content = readFileSync(join(thisdir, '..', 'template', template), {encoding: 'utf8'})
        .replaceAll('%%package_name%%', pkgName)
        .replaceAll('%%circuit_name%%', circuitName)
        .replaceAll('%%snarkjs_version%%', snarkjsVersion)
        .replaceAll('%%protocol%%', event.payload.protocol)
        .replaceAll('%%wasm_path%%', wasmPath)
        .replaceAll('%%pkey_path%%', pkeyPath)
        .replaceAll('%%vkey%%', vkey);
      writeFileSync(join(dirPkg, template), content);
    }

    // Circom sources to S3
    await zipDirectory(dirCircuits, dirPkg + '-source.zip');
    await uploadLargeFileToS3(`build/${pkgName}/source.zip`, dirPkg + '-source.zip');
    // Solidity verifier to s3
    await uploadLargeFileToS3(`build/${pkgName}/verifier.sol`, contractPath);
    // Entire package to s3
    await zipDirectory(dirPkg, dirPkg + '.zip');
    await uploadLargeFileToS3(`build/${pkgName}/pkg.zip`, dirPkg + '.zip');
    // Info file to s3
    writeFileSync(join(dirPkg, 'info.json'), JSON.stringify({
      requestId: event.payload.requestId,
      circomPath: event.payload.circomPath,
      snarkjsVersion,
      protocol: event.payload.protocol,
      circuit: event.payload.circuit,
      soliditySize: statSync(contractPath).size,
      sourceSize: statSync(dirPkg + '-source.zip').size,
      pkgSize: statSync(dirPkg + '.zip').size,
    }, null, 2));
    await uploadLargeFileToS3(`build/${pkgName}/info.json`, join(dirPkg, 'info.json'));
    status.stopMemoryLogs();
    await status.log(`Complete.`);
  } catch(error) {
    // TODO error data should be passed as data parameter so cli can halt on error
    await status.log(error.toString());
    throw error;
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      pkgName,
    }),
  };
}
