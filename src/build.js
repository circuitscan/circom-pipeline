import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';

import {Circomkit} from 'circomkit';
// TODO does this change with the 0.2.0 refactor?
import {getPtauName} from 'circomkit/dist/utils/ptau.js';
import * as snarkjs from 'snarkjs';
import { uniqueNamesGenerator, adjectives, colors, animals } from 'unique-names-generator';

import {
  executeCommand,
  downloadBinaryFile,
  uploadLargeFileToS3,
  zipDirectory,
  mkdirpSync,
} from './utils.js';

export const BUILD_NAME = 'verify_circuit';
const HARDHAT_IMPORT = 'import "hardhat/console.sol";';

export async function build(event) {
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
  // TODO allow specifying snarkjs version (groth16 template changed in 0.7.4)
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
    const content = readFileSync(join(thisdir, '..', 'template', template), {encoding: 'utf8'})
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
  // Info file to s3
  writeFileSync(join(dirPkg, 'info.json'), JSON.stringify({
    circomPath: event.payload.circomPath,
    protocol: event.payload.protocol,
    circuit: event.payload.circuit,
    soliditySize: statSync(contractPath).size,
    sourceSize: statSync(dirPkg + '-source.zip').size,
    pkgSize: statSync(dirPkg + '.zip').size,
  }, null, 2));
  await uploadLargeFileToS3(pkgName + '/info.json', join(dirPkg, 'info.json'));

  return {
    statusCode: 200,
    body: JSON.stringify({
      pkgName,
    }),
  };
}

