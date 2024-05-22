import {findChain} from './chains.js';

export async function verify(event) {
  if(!event.payload.chainId)
    throw new Error('missing_chainId');
  const chain = findChain(event.payload.chainId);
  if(!chain)
    throw new Error('invalid_chainId');
  if(!event.payload.contract)
    throw new Error('missing_contract');
  if(!event.payload.pkgName)
    throw new Error('missing_pkgName');

  // Load etherscan verified contract
  const verified = await etherscanSource(chain, event.payload.contract);
  if(!verified)
    throw new Error('contract_not_verified');

  // Load contract from s3
  const compiled = await compiledSource(event.payload.pkgName);

  // Compare differences
  console.log(verified, compiled);

  return {
    statusCode: 200,
    body: JSON.stringify({
      foo: 'bar',
    }),
  };
}

async function compiledSource(pkgName) {
  const resp = await fetch(process.env.BLOB_URL + pkgName + '/verifier.sol');
  return resp.text();
}

async function etherscanSource(chain, address) {
  const resp = await fetch(
    chain.apiUrl +
    '?module=contract' +
    '&action=getsourcecode' +
    '&address=' + address +
    '&apikey=' + chain.apiKey
  );
  const data = await resp.json();
  if(!data.result[0].SourceCode) return null;

  let sources;
  let code = data.result[0].SourceCode;
  // Some Etherscans have double curlies, some don't?
  if(code.indexOf('{{') === 0) {
    code = code.slice(1, -1);
  }
  if(code.indexOf('{') === 0) {
    // Etherscan provided an object with multiple solidity sources
    const inner = JSON.parse(code);
    sources = Object.keys(inner.sources).reduce((out, file) => {
      out[file] = inner.sources[file].content;
      return out;
    }, {});
  } else {
    // Some Etherscans send just a string if it's one file
    sources = { 'verifier.sol': code };
  }
  return sources;
}
