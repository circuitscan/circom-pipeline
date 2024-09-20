CIRCOM_PATH=`node -e "process.stdout.write(require('../event.json').circomPath)"`
CIRCOM_VERSION=`node -e "process.stdout.write(require('../event.json').circomPath.slice(7))"`

curl -Lo /tmp/$CIRCOM_PATH https://github.com/iden3/circom/releases/download/$CIRCOM_VERSION/circom-linux-amd64
chmod +x /tmp/$CIRCOM_PATH
mv /tmp/$CIRCOM_PATH /usr/local/bin
