import {strictEqual} from 'node:assert';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import fse from 'fs-extra';
import hardhat from 'hardhat';
import solc from 'solc';
import { S3Client, DeleteObjectsCommand } from "@aws-sdk/client-s3";

import {FileServer} from './utils/FileServer.js';
import {MockStatusReporter} from './mock/MockStatusReporter.js';

import circomPipeline, {BUILD_NAME} from '../src/index.js';

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
});

const fileServers = [];

const EVENTS = [
  {
    payload: {
      requestId: randomBytes(16).toString('hex'),
      action: 'build',
      files: {
        'multiplier.circom': {
          code: readFileSync('test/circuits/multiplier.circom', {encoding: 'utf8'}),
        },
      },
      circomPath: 'circom-v2.1.8',
      protocol: 'plonk',
      prime: 'bn128',
      circuit: {
        file: 'multiplier',
        template: 'Multiplier',
        params: [2],
        pubs: [],
      },
    },
  },
  {
    payload: {
      requestId: randomBytes(16).toString('hex'),
      action: 'build',
      files: {
        'multiplier.circom': {
          code: readFileSync('test/circuits/multiplier.circom', {encoding: 'utf8'}),
        },
      },
      circomPath: 'circom-v2.1.8',
      protocol: 'fflonk',
      prime: 'bn128',
      circuit: {
        file: 'multiplier',
        template: 'Multiplier',
        params: [2],
        pubs: [],
      },
    },
  },
  {
    payload: {
      requestId: randomBytes(16).toString('hex'),
      action: 'build',
      files: {
        'multiplier.circom': {
          code: readFileSync('test/circuits/multiplier.circom', {encoding: 'utf8'}),
        },
      },
      circomPath: 'circom-v2.1.8',
      protocol: 'groth16',
      prime: 'bn128',
      circuit: {
        file: 'multiplier',
        template: 'Multiplier',
        params: [2],
        pubs: [],
      },
    },
  },
  {
    payload: {
      requestId: randomBytes(16).toString('hex'),
      action: 'build',
      files: {
        'multiplier.circom': {
          code: readFileSync('test/circuits/multiplier.circom', {encoding: 'utf8'}),
        },
      },
      circomPath: 'circom-v2.1.8',
      protocol: 'groth16',
      optimization: 1,
      prime: 'bn128',
      finalZkey: readFileSync('test/test.zkey').toString('base64'),
      circuit: {
        file: 'multiplier',
        template: 'Multiplier',
        params: [2],
        pubs: [],
      },
    },
  },
  async function() {
    // Zkeys can also be loaded over https
    const fileServer = new FileServer('test/test.zkey', true);
    fileServers.push(fileServer);
    const fileServerPort = await fileServer.start();
    return {
      payload: {
        requestId: randomBytes(16).toString('hex'),
        action: 'build',
        files: {
          'multiplier.circom': {
            code: readFileSync('test/circuits/multiplier.circom', {encoding: 'utf8'}),
          },
        },
        circomPath: 'circom-v2.1.8',
        protocol: 'groth16',
        optimization: 1,
        prime: 'bn128',
        finalZkey: `https://localhost:${fileServerPort}/`,
        circuit: {
          file: 'multiplier',
          template: 'Multiplier',
          params: [2],
          pubs: [],
        },
      },
    };
  },
  {
    test: {
      checkFail(status, error) {
        if(error.message !== 'invalid_finalZkey') return false;
        for(let i = status.length - 1; i > -1; i--) {
          if(status[i].msg.includes('Invalid finalZkey!')) return true;
        }
      },
    },
    payload: {
      requestId: randomBytes(16).toString('hex'),
      action: 'build',
      files: {
        'multiplier.circom': {
          code: readFileSync('test/circuits/multiplier.circom', {encoding: 'utf8'}),
        },
      },
      circomPath: 'circom-v2.1.8',
      protocol: 'groth16',
      optimization: 1,
      prime: 'bn128',
      finalZkey: readFileSync('test/test-fail.zkey').toString('base64'),
      circuit: {
        file: 'multiplier',
        template: 'Multiplier',
        params: [2],
        pubs: [],
      },
    },
  },
];

describe('Circom pipeline', function () {
  after(async () => {
    fileServers.forEach(server => server.server.close());
  });

  EVENTS.forEach((EVENT, index) => {
  it(`should make a package that can prove and verify #${index}`, async function () {
    this.timeout(20000);

    if(typeof EVENT === 'function') EVENT = await EVENT();

    const status = new MockStatusReporter;
    let pkgName;
    try {
      pkgName = await circomPipeline(EVENT, { status });
    } catch(error) {
      if(('test' in EVENT) && (typeof EVENT.test.checkFail === 'function')) {
        strictEqual(EVENT.test.checkFail(status.logs, error), true);
        return;
      }
      throw error;
    }

    const dirPkg = join(tmpdir(), pkgName);
    const newPath = join('node_modules', pkgName);
    // Node won't import from outside this directory
    fse.moveSync(dirPkg, newPath);

    const {prove, verify} = await import(pkgName);

    const {proof, calldata} = await prove({ in: [3,4] });

    strictEqual(parseInt(proof.publicSignals[0], 10), 3*4);
    strictEqual(await verify(proof), true);

    // Also check that the generated contract can verify proofs
    // Compile the contract
    const solidityPath = join(newPath, 'build', BUILD_NAME, `${EVENT.payload.protocol}_verifier.sol`);
    const input = {
      language: 'Solidity',
      sources: {
        'TestVerifier.sol': {
          content: readFileSync(solidityPath, {encoding: 'utf-8'})
        }
      },
      settings: {
        outputSelection: {
          '*': {
            '*': ['abi', 'evm.bytecode.object']
          }
        }
      }
    };

    const output = JSON.parse(solc.compile(JSON.stringify(input)));
    const contractName = Object.keys(output.contracts['TestVerifier.sol'])[0];
    const bytecode = output.contracts['TestVerifier.sol'][contractName].evm.bytecode.object;
    const abi = output.contracts['TestVerifier.sol'][contractName].abi;

    // Deploy the contract using ethers
    const ContractFactory = new hardhat.ethers.ContractFactory(abi, bytecode, (await hardhat.ethers.getSigners())[0]);
    const contract = await ContractFactory.deploy();
    await contract.waitForDeployment();

    // Interaction with the contract
    strictEqual(await contract.verifyProof(...calldata), true);

    // Cleanup filesystem
    fse.removeSync(newPath);
    // Cleanup S3
    await deleteS3Keys([
      pkgName + '/source.zip',
      pkgName + '/verifier.sol',
      pkgName + '/pkg.zip',
      pkgName + '/info.json',
    ]);

  })});
});


async function deleteS3Keys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("Keys are required, and keys must be a non-empty array.");
  }

  const deleteParams = {
    Bucket: process.env.BLOB_BUCKET,
    Delete: {
      Objects: keys.map((key) => ({ Key: key })),
      Quiet: false,
    },
  };

  try {
    const data = await s3Client.send(new DeleteObjectsCommand(deleteParams));
  } catch (error) {
    console.error("Error deleting objects:", error);
    throw error;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(() => resolve(), ms));
}
