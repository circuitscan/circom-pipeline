import {readFileSync} from 'node:fs';
import {handler} from '../index.js';

async function test1() {
  const event = {
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
  };

  const result = await handler(event);
  console.log(result);
}

test1();
