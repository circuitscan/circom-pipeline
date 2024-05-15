import {strictEqual} from 'node:assert';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import fse from 'fs-extra';
import hardhat from 'hardhat';
import solc from 'solc';
import { S3Client, DeleteObjectsCommand } from "@aws-sdk/client-s3";

import {FileServer} from './utils/FileServer.js';

import {handler, BUILD_NAME} from '../index.js';

const s3Client = new S3Client({
  endpoint: process.env.AWS_ENDPOINT,
});

const fileServers = [];

const EVENTS = [
  {
    payload: {
      action: 'build',
      files: {
        'multiplier.circom': {
          code: readFileSync('test/circuits/multiplier.circom', {encoding: 'utf8'}),
        },
      },
      circomPath: 'circom',
      protocol: 'plonk',
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
      action: 'build',
      files: {
        'multiplier.circom': {
          code: readFileSync('test/circuits/multiplier.circom', {encoding: 'utf8'}),
        },
      },
      circomPath: 'circom',
      protocol: 'fflonk',
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
      action: 'build',
      files: {
        'multiplier.circom': {
          code: readFileSync('test/circuits/multiplier.circom', {encoding: 'utf8'}),
        },
      },
      circomPath: 'circom',
      protocol: 'groth16',
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
      action: 'build',
      files: {
        'multiplier.circom': {
          code: readFileSync('test/circuits/multiplier.circom', {encoding: 'utf8'}),
        },
      },
      circomPath: 'circom',
      protocol: 'groth16',
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
        action: 'build',
        files: {
          'multiplier.circom': {
            code: readFileSync('test/circuits/multiplier.circom', {encoding: 'utf8'}),
          },
        },
        circomPath: 'circom',
        protocol: 'groth16',
        finalZkey: `https://localhost:${fileServerPort}/`,
        circuit: {
          file: 'multiplier',
          template: 'Multiplier',
          params: [2],
          pubs: [],
        },
      },
    };
  }
];

describe('Lambda Function', function () {
  after(async () => {
    await globalThis.curve_bn128.terminate();
    fileServers.forEach(server => server.server.close());
  });

  EVENTS.forEach((EVENT, index) => {
  it(`should make a package that can prove and verify #${index}`, async function () {
    this.timeout(10000);

    if(typeof EVENT === 'function') EVENT = await EVENT();

    EVENT.payload.dryRun = true;

    const result = await handler(EVENT);

    strictEqual(result.statusCode, 200);
    const body = JSON.parse(result.body);
    const dirPkg = join(tmpdir(), body.pkgName);
    const newPath = join('node_modules', body.pkgName);
    // Node won't import from outside this directory
    fse.moveSync(dirPkg, newPath)

    const {prove, verify} = await import(body.pkgName);

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
      body.pkgName + '/source.zip',
      body.pkgName + '/verifier.sol',
      body.pkgName + '/pkg.zip',
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
    console.log("Delete operation completed successfully:", data);
  } catch (error) {
    console.error("Error deleting objects:", error);
    throw error;
  }
}
