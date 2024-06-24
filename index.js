import {build} from './src/build.js';

// TODO verify api-key against s3, store request id in `api-key/<key>.json`
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
