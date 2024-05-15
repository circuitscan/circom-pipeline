# Circom Compiler Lambda Docker Container

Input a Circom circuit source and compiler configuration to generate (and upload to S3) zip of sources, Solidity verifier, and zip with build artifacts and development library:

* Circuit sources configured into [Circomkit](https://github.com/erhant/circomkit)
* All the build artifacts (including verifier Solidity source)
* An exposed method to generate a proof and caldata from your application easily
  ```js
    import {prove} from 'snarkjs-prover-multiplier-xxxxxxxxx';

    console.log(await prove({ in: [3,4] }));
    /*
    {
      proof: {
        proof: {
          pi_a: [Array],
          pi_b: [Array],
          pi_c: [Array],
          protocol: 'groth16',
          curve: 'bn128'
        },
        publicSignals: [ '12' ]
      },
      calldata: [
        [
          '0x20400eec228fd0aab8fdba57b3c92c97305259066c3dc4cd9073f00b9d4d371d',
          '0x28c37b1e79e8440f249d8f2c495c4387ec81189c643007bc3411e588773254bf'
        ],
        [ [Array], [Array] ],
        [
          '0x21bb3d87e363849029f37be15852136c780e7b07856b9c0b8c8bad5179f21ab2',
          '0x0063c20e5f781eb1d86db0877a56aa16725dba3c55863412de01bd6ce102294d'
        ],
        [
          '0x000000000000000000000000000000000000000000000000000000000000000c'
        ]
      ]
    }
    */
  ```

## Running tests

```sh
$ cp .env.example .env
# Update S3 configuration
$ vim .env
$ yarn test
```

## License

MIT
