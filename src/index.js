#!/usr/bin/env node

/**
 * KEF LSX YouTube Music Cast Bridge
 * Bridges YouTube & YouTube Music "Cast to" directly to KEF LSX speakers via DLNA / UPnP.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const YouTubeCastReceiver = require('yt-cast-receiver').default || require('yt-cast-receiver');
const { PlaylistRequestHandler } = require('yt-cast-receiver');
const StreamServer = require('./stream-server');
const KefPlayer = require('./kef-player');

// Custom PlaylistRequestHandler to bypass youtubei.js decipher errors
class SimplePlaylistRequestHandler extends PlaylistRequestHandler {
  async getPreviousNextVideos(target, playlist) {
    const videoIds = (playlist && playlist.videoIds) ? playlist.videoIds : [];
    const currentIndex = videoIds.indexOf(target.id);
    let previous = null;
    let next = null;

    if (currentIndex > 0) {
      previous = { id: videoIds[currentIndex - 1], client: target.client };
    }
    if (currentIndex >= 0 && currentIndex < videoIds.length - 1) {
      next = { id: videoIds[currentIndex + 1], client: target.client };
    }

    return { previous, next };
  }
}

// 1. Load config file
const candidateConfigPaths = [
  process.env.CONFIG_PATH,
  path.join(process.cwd(), 'config.json'),
  path.join(__dirname, '..', 'config.json'),
  path.join(__dirname, 'config.json')
].filter(Boolean);

let configPath = candidateConfigPaths.find(p => fs.existsSync(p));

let config = {
  kef: { ip: process.env.KEF_IP || '', port: parseInt(process.env.KEF_PORT, 10) || 8080 },
  receiver: { deviceName: 'KEF LSX', dialPort: 8098, streamPort: 8099, hostIp: 'auto' },
  audio: {
    ytdlpPath: 'yt-dlp',
    ffmpegPath: 'ffmpeg'
  }
};

if (configPath && fs.existsSync(configPath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config = {
      ...config,
      ...parsed,
      kef: { ...config.kef, ...(parsed.kef || {}) },
      receiver: { ...config.receiver, ...(parsed.receiver || {}) },
      audio: { ...config.audio, ...(parsed.audio || {}) }
    };
  } catch (e) {
    console.warn('[Config] Failed to parse config.json, using defaults.');
  }
}

// 2. Override with Environment Variables if present (e.g. Docker / Synology)
if (process.env.KEF_IP) config.kef.ip = process.env.KEF_IP;
if (process.env.KEF_PORT) config.kef.port = parseInt(process.env.KEF_PORT, 10);
if (process.env.DEVICE_NAME) config.receiver.deviceName = process.env.DEVICE_NAME;
if (process.env.DIAL_PORT) config.receiver.dialPort = parseInt(process.env.DIAL_PORT, 10);
if (process.env.STREAM_PORT) config.receiver.streamPort = parseInt(process.env.STREAM_PORT, 10);
if (process.env.HOST_IP) config.receiver.hostIp = process.env.HOST_IP;
if (process.env.YTDLP_PATH) config.audio.ytdlpPath = process.env.YTDLP_PATH;
if (process.env.FFMPEG_PATH) config.audio.ffmpegPath = process.env.FFMPEG_PATH;

// Check if speaker IP is set
if (!config.kef || !config.kef.ip) {
  console.error('Error: KEF speaker IP is not configured.');
  console.error('Please set the KEF_IP environment variable (e.g. KEF_IP=192.168.0.10) or configure "kef.ip" in config.json.');
  process.exit(1);
}

// Check if conda dev yt-dlp path exists locally if default is not in PATH
if (config.audio.ytdlpPath === 'yt-dlp') {
  console.error('Error: yt-dlp not found. Please install');
}

function getLocalIp(targetIp = config.kef.ip) {
  if (config.receiver && config.receiver.hostIp && config.receiver.hostIp !== 'auto') {
    return config.receiver.hostIp;
  }
  if (process.env.HOST_IP && process.env.HOST_IP !== 'auto') {
    return process.env.HOST_IP;
  }

  // 1. Query OS routing table for the local interface IP that routes to target speaker
  try {
    const socket = dgram.createSocket('udp4');
    socket.connect(80, targetIp);
    const addr = socket.address().address;
    socket.close();
    if (addr && addr !== '0.0.0.0' && addr !== '127.0.0.1') {
      return addr;
    }
  } catch (e) { }

  // 2. Scan network interfaces matching target subnet
  const targetSubnet = targetIp.split('.').slice(0, 3).join('.');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (iface.address.startsWith(targetSubnet)) {
          return iface.address;
        }
      }
    }
  }

  // 3. Fallback to any physical LAN IPv4
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('172.17.') && !iface.address.startsWith('172.18.')) {
        return iface.address;
      }
    }
  }

  return '127.0.0.1';
}

const localIp = getLocalIp(config.kef.ip);

async function bootstrap() {
  console.log('='.repeat(65));
  console.log('      KEF LSX YouTube Music Cast Bridge Server');
  console.log('='.repeat(65));
  console.log(` Speaker Target : http://${config.kef.ip}:${config.kef.port}`);
  console.log(` Device Name    : "${config.receiver.deviceName}"`);
  console.log(` Local Stream IP: ${localIp}:${config.receiver.streamPort}`);
  console.log(` DIAL Discovery : Port ${config.receiver.dialPort}`);
  console.log('='.repeat(65));

  // 1. Start HTTP Audio Stream Server
  const streamServer = new StreamServer({
    port: config.receiver.streamPort,
    ytdlpPath: config.audio?.ytdlpPath || 'yt-dlp',
    ffmpegPath: config.audio?.ffmpegPath || 'ffmpeg'
  });
  await streamServer.start();
  console.log(`[Audio Streamer] Ready on port ${config.receiver.streamPort}`);

  // 2. Instantiate KefPlayer
  const player = new KefPlayer({
    kefIp: config.kef.ip,
    kefPort: config.kef.port,
    streamPort: config.receiver.streamPort,
    serverHost: localIp,
    streamServer
  });

  // 3. Instantiate YouTubeCastReceiver
  const receiver = new YouTubeCastReceiver(player, {
    app: {
      playlistRequestHandler: new SimplePlaylistRequestHandler()
    },
    dial: {
      port: config.receiver.dialPort,
      prefix: '/ytcr'
    },
    device: {
      name: config.receiver.deviceName,
      screenName: `YouTube on ${config.receiver.deviceName}`,
      brand: 'KEF',
      model: 'LSX'
    },
    logLevel: 'INFO'
  });

  // 4. Sender Events
  receiver.on('senderConnect', (sender) => {
    console.log(`\n[Connected] Device connected: "${sender.name}"`);
  });

  receiver.on('senderDisconnect', (sender, implicit) => {
    console.log(`\n[Disconnected] Device disconnected: "${sender.name}" (Implicit: ${implicit})`);
  });

  // 5. Pairing Code Service (Link with TV code)
  const pairingService = receiver.getPairingCodeRequestService();
  pairingService.on('response', (code) => {
    const formatted = code.replace(/(\d{3})(?=\d)/g, '$1 ');
    console.log('\n' + '-'.repeat(65));
    console.log(`  YOUTUBE TV LINK CODE : [ ${formatted} ]`);
    console.log('  In YouTube Music App: Tap Cast -> "Link with TV code"');
    console.log('  Enter this code to link your speakers permanently!');
    console.log('-'.repeat(65) + '\n');
  });

  pairingService.on('error', (err) => {
    console.warn('⚠️ [Pairing Code Service] Error:', err.message);
  });

  // 6. Start Receiver & Pairing Service
  try {
    await receiver.start();
    pairingService.start();
    console.log(`[Cast Receiver] Broadcasting "${config.receiver.deviceName}" on local network!`);
    console.log('   Open YouTube Music on your phone or PC and tap the Cast button.\n');
  } catch (err) {
    console.error('[Receiver Error] Failed to start:', err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down KEF Cast Bridge...');
    pairingService.stop();
    await receiver.stop().catch(() => { });
    streamServer.stop();
    await player.doStop().catch(() => { });
    console.log('👋 Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
