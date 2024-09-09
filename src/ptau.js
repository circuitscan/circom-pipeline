import {createWriteStream} from 'node:fs';
import {get} from 'node:https';

// Adapted from https://github.com/erhant/circomkit/blob/main/src/utils/ptau.ts

/** Base PTAU URL as seen in [SnarkJS docs](https://github.com/iden3/snarkjs#7-prepare-phase-2). */
const PTAU_URL_BASE = 'https://storage.googleapis.com/zkevm/ptau';

/**
 * Returns the name of PTAU file for a given size.
 * @see https://github.com/iden3/snarkjs#7-prepare-phase-2
 * @param p ptau size
 * @returns name of the PTAU file
 */
export function getPtauName(p) {
  let id = ''; // default for large values
  if (p < 8) {
    id = '_08';
  } else if (p < 10) {
    id = `_0${p}`;
  } else if (p < 28) {
    id = `_${p}`;
  } else if (p === 28) {
    id = '';
  } else {
    throw new Error('No PTAU for that many constraints!');
  }
  return `powersOfTau28_hez_final${id}.ptau`;
}

/**
 * Downloads phase-1 powers of tau from Polygon Hermez.
 * @see https://github.com/iden3/snarkjs#7-prepare-phase-2
 * @param ptauName name of PTAU file
 * @param ptauPath where to save the file
 * @returns path to downloaded PTAU file
 */
// TODO reject on failure?
export function downloadPtau(ptauName, ptauPath) {
  const file = createWriteStream(ptauPath);
  return new Promise(resolve => {
    get(`${PTAU_URL_BASE}/${ptauName}`, response => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(ptauPath);
      });
    });
  });
}
