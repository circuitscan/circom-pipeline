import {strictEqual} from 'node:assert';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import fse from 'fs-extra';
import hardhat from 'hardhat';
import solc from 'solc';

import {handler, BUILD_NAME} from '../index.js';

// Not used during test but it's still checked
process.env.NPM_AUTH_TOKEN = 'npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

const EVENT = {
  payload: {
    action: 'build',
    dryRun: true,
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
};

describe('Lambda Function', function () {
  it('should make a package that can prove and verify', async function () {
    this.timeout(10000);

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

    fse.removeSync(newPath);

  });
});
