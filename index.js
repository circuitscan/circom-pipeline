import {readFileSync, writeFileSync, mkdtempSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {exec} from 'node:child_process';

import {Circomkit} from 'circomkit';
import { uniqueNamesGenerator, adjectives, colors, animals } from 'unique-names-generator';

export const BUILD_NAME = 'verify_circuit';
const HARDHAT_IMPORT = 'import "hardhat/console.sol";';

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
  const authToken = String(process.env.NPM_AUTH_TOKEN);
  if(authToken.length !== 40 || !authToken.startsWith('npm_'))
    throw new Error('INVALID_NPM_AUTH_TOKEN');

  const cfgPath = join(mkdtempSync(join(tmpdir(), 'cfg-')), '.npmrc');
  writeFileSync(cfgPath, `//registry.npmjs.org/:_authToken=${authToken}`);

  const circuitName = event.payload.circuit.template.toLowerCase();

  const pkgName = `snarkjs-prover-${circuitName}-${uniqueNamesGenerator({
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
    let code = event.payload.files[file].code;
    const matches = code.matchAll(/include "([^"]+)";/g);
    const imports = Array.from(matches);
    for(let include of imports) {
      const filename = include[1].split('/').at(-1);
      code = code.replaceAll(include[0], `include "${filename}";`);
    }
    writeFileSync(join(dirCircuits, file), code);
  }

  const config = {
    dirCircuits,
    dirPtau,
    dirBuild,
    circomPath: event.payload.circomPath,
    protocol: event.payload.protocol,
  };

  // TODO support deterministic groth16 compilations
  // https://github.com/circuitscan/circuitscan/issues/4
  if(config.protocol === 'groth16') {
    Object.assign(config, {
      prime: 'bn128',
      groth16numContributions: 1,
      groth16askForEntropy: false,
    });
  }

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

  await circomkit.setup(BUILD_NAME);
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

  // Publish result to NPM
  await executeCommand(`npm publish ${event.payload.dryRun ? '--dry-run' : ''} --userconfig ${cfgPath} ${dirPkg}`);

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

