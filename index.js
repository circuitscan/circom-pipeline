import {build} from './src/build.js';
import {verify} from './src/verify.js';

export async function handler(event) {
  if('body' in event) {
    // Running on AWS
    event = JSON.parse(event.body);
  }
  try {
    switch(event.payload.action) {
      case 'build':
        return await build(event);
      case 'verify':
        return await verify(event);
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
