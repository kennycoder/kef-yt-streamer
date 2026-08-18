const fs = require('fs');
const KefUpnpClient = require('../src/kef-upnp');
const kefIp = process.env.KEF_IP;
if (!kefIp) {
  console.error('Error: KEF_IP environment variable is not set. Example: KEF_IP=192.168.0.10 npm run test:upnp');
  process.exit(1);
}
const kefPort = parseInt(process.env.KEF_PORT, 10) || 8080;
const kef = new KefUpnpClient(kefIp, kefPort);

async function main() {
  try {
    const vol = await kef.getVolume();
    const info = await kef.getTransportInfo();
    const pos = await kef.getPositionInfo();
    const result = `KEF Volume: ${vol}\nTransport: ${JSON.stringify(info)}\nPosition: ${JSON.stringify(pos)}\n`;
    console.log(result);
  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
