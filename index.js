import {build} from './src/build.js';
import {transformS3Json} from './src/utils.js';

export async function handler(event, options) {
  if('body' in event) {
    // Running on AWS
    event = JSON.parse(event.body);
  }
  try {
    //
    if(!options || !options.ignoreApiKey) {
      // Ensure API key is active and save the request ID
      await transformS3Json(process.env.APIKEY_BUCKET, `uses/${event.apiKey}.json`, data => {
        if(!('address' in data))
          throw new Error('invalid_api_key');
        if(data.inactive)
          throw new Error('inactive_api_key');

        data.requests.push(event.payload.requestId);
        return data;
      });
    }

    // Perform the action
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
