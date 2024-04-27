# %%package_name%%

This is the result of building the %%circuit_name%% Circom circuit using the %%protocol%% protocol.

Add this package to your project to prove or verify this circuit.

```js
import {prove, verify} from '%%package_name%%';

// Specify your input signals to generate a proof
// ex. A circuit with: signal input in[2];
const {proof, calldata} = await prove({ in: [3,4] });

if(await verify(proof)) {
  console.log('Proof verified!');
} else {
  console.log('Unable to verify proof.');
}
```

Or, develop on the circuit from this package's directory using the included `circomkit.json` and `circuits.json` configuration.

