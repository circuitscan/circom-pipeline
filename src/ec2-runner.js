import {readFileSync} from 'node:fs';

import {handler} from '../index.js';
import {uploadJsonToS3} from './utils.js';

async function eventFromFile() {
  const payload = JSON.parse(readFileSync(process.argv[2], {encoding:'utf8'}));
  await uploadJsonToS3(
    process.env.BLOB_BUCKET,
    `instance-response/${payload.requestId}.json`,
    await handler({ payload }),
  );
  globalThis.curve_bn128 && await globalThis.curve_bn128.terminate();
}

eventFromFile();
