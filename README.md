# KEF LSX YouTube Music Cast Bridge

A lightweight Cast Receiver bridge that lets you cast songs, albums, and playlists directly from the **YouTube Music** (and YouTube) app to your **KEF LSX** speakers via DLNA / UPnP.

---

## Features

- **Native "Cast to" Support**: Tap the Cast button in YouTube Music on Android, iOS, or Desktop Chrome/Edge and select **"KEF LSX"**.
- **Permanent "Link with TV Code"**: Automatically generates a 12-digit YouTube TV code so you can link your speaker permanently in YouTube Music settings, even across different Wi-Fi bands or subnets.
- **Full Playback Control**:
  - Play / Pause / Resume
  - Seek / Scrubbing
  - Volume Control & Mute synchronization
  - Next / Previous track
- **Continuous Album & Playlist Playback**: Automatically monitors speaker playback state and advances to the next song in your queue.
- **Smart Two-Way Playback Synchronization**:
  - **Speaker Power / State Feedback**: Automatically detects when speakers are powered off, put in standby, paused via remote, or switched to another input, and notifies your phone to stop playback while terminating server audio streams.
  - **Device Switch / Disconnect Teardown**: Automatically stops speaker playback and kills server stream processes when you disconnect or switch casting to another device.
- **High-Fidelity Audio**: Direct 320kbps MP3 / AAC audio pipeline using `yt-dlp` and `ffmpeg`.
- **Synology NAS / Docker Ready**: Runs as an always-on background container on Synology Container Manager with `host` networking for SSDP and DLNA.

---

## Quick Start with Docker Hub

A pre-built Docker image is available on Docker Hub: [`kennycoder/kef-yt-streamer:latest`](https://hub.docker.com/r/kennycoder/kef-yt-streamer)

### One-line Docker Run
```bash
docker run -d \
  --name kef-yt-cast-bridge \
  --network host \
  --restart unless-stopped \
  -e KEF_IP=192.168.0.10 \
  -e DEVICE_NAME="KEF LSX" \
  -v $(pwd)/data:/app/data \
  kennycoder/kef-yt-streamer:latest
```
*(Make sure to replace `192.168.0.10` with your KEF speaker's IP address)*

---

## Running on Synology NAS (Container Manager)

Running this container on your Synology NAS is the most ideal setup because the NAS is always powered on and connected to your local network.

### Method 1: Using Synology Container Manager (GUI with Pre-built Image)

1. Open **Container Manager** on your Synology DSM.
2. Go to **Registry** $\rightarrow$ Search for `kennycoder/kef-yt-streamer` $\rightarrow$ Download the `latest` image.
3. Go to **Container** $\rightarrow$ **Create**:
   - **Image**: `kennycoder/kef-yt-streamer:latest`
   - **Container Name**: `kef-yt-cast-bridge`
   - **Network**: Select **host** *(critical for SSDP multicast & DLNA)*
   - **Environment Variables**: Add `KEF_IP` (e.g. `192.168.0.10`) and `DEVICE_NAME` (e.g. `KEF LSX`)
   - **Volume**: Map a local folder (e.g., `/docker/kef-yt-streamer/data`) to `/app/data`
4. Click **Done** to start the container.
5. Go to **Container** $\rightarrow$ Click on `kef-yt-cast-bridge` $\rightarrow$ **Log** to see the YouTube TV Link Code.

---

### Method 2: Using Docker Compose (CLI / SSH)

1. Transfer this folder to your NAS:
   ```bash
   scp -r kef-yt-streamer user@your-nas-ip:/volume1/docker/kef-yt-streamer
   ```
2. SSH into your Synology NAS:
   ```bash
   ssh user@your-nas-ip
   cd /volume1/docker/kef-yt-streamer
   ```
3. Build and launch the container in the background:
   ```bash
   docker compose up -d --build
   ```
4. View real-time logs and the pairing code:
   ```bash
   docker compose logs -f
   ```

---

## How to Cast from YouTube Music

1. **Option A (Instant Cast)**: Open **YouTube Music** on your phone or PC connected to your home network. Tap the **Cast** icon and select **"KEF LSX"**.
2. **Option B (TV Code Pairing)**:
   - In the YouTube Music app, tap your profile picture / settings $\rightarrow$ **"Watch on TV"** (or tap Cast $\rightarrow$ **"Link with TV code"**).
   - Enter the 12-digit code displayed in the container logs (e.g. `772 259 831 228`).
   - Your **KEF LSX** will now permanently appear in your Cast list!

---

## Configuration (`config.json` / Environment Variables)

You can configure the speaker IP and options in `config.json` or via environment variables in `docker-compose.yml`:

```json
{
  "kef": {
    "ip": "192.168.0.10",
    "port": 8080
  },
  "receiver": {
    "deviceName": "KEF LSX",
    "dialPort": 8098,
    "streamPort": 8099,
    "hostIp": "auto",
    "autoStopOnSpeakerOff": true,
    "autoStopOnDisconnect": true
  },
  "audio": {
    "format": "mp3",
    "bitrate": "320k",
    "ytdlpPath": "yt-dlp",
    "ffmpegPath": "ffmpeg"
  }
}
```

### Environment Variables for Docker:
- `KEF_IP`: IP address of the KEF LSX speaker (default: `192.168.0.10`)
- `KEF_PORT`: UPnP port on the speaker (default: `8080`)
- `DEVICE_NAME`: Name displayed in the Cast menu (default: `KEF LSX`)
- `DIAL_PORT`: DIAL discovery port (default: `8098`)
- `STREAM_PORT`: Local audio streamer port (default: `8099`)
- `HOST_IP`: Host LAN IP (default: `auto`)
- `AUTO_STOP_ON_SPEAKER_OFF`: Auto-stop and notify phone when speaker turns off / pauses / switches input (default: `true`)
- `AUTO_STOP_ON_DISCONNECT`: Auto-stop speaker playback and server stream when phone disconnects / switches device (default: `true`)

---

## Running Locally on your machine

- **Using NPM**:
  ```bash
  npm start
  ```
- **Using Linux / Mac Shell Script**:
  ```bash
  ./scripts/start.sh
  ```
- **Using Windows Batch Script**:
  ```cmd
  scripts\start.bat
  ```
- **Using Docker Locally**:
  ```bash
  docker compose up -d
  ```

---

## Project Structure

```text
kef-yt/
├── config.json              # Main configuration file (speaker IP, ports, paths)
├── Dockerfile               # Docker container definition
├── docker-compose.yml       # Docker Compose service definition
├── package.json             # Node.js project manifest & scripts
├── src/                     # Core application source code
│   ├── index.js             # Server bootstrap & DIAL / Cast Receiver service
│   ├── kef-player.js        # Cast Player implementation for KEF LSX UPnP
│   ├── kef-upnp.js          # SOAP / UPnP DLNA client for KEF LSX
│   └── stream-server.js     # HTTP Audio Streaming Server (yt-dlp + ffmpeg)
├── scripts/                 # Launcher and service files
│   ├── start.sh             # Linux / macOS launch script
│   ├── start.bat            # Windows launch script
└── tools/                   # Diagnostic and testing utilities
    ├── test_node.js         # Node.js UPnP diagnostic test
    ├── test_kef_upnp.py     # Python UPnP test suite
    └── kef_upnp_client.py   # Python SOAP test client
```

---

## Diagnostic Tools

Run standalone diagnostic tests:
- **Node UPnP Check**: `npm run test:upnp`
- **Python UPnP Check**: `python tools/test_kef_upnp.py`
