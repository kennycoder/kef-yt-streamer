/**
 * KefPlayer - Custom Player for YouTube Cast Receiver
 * Extends yt-cast-receiver's Player class and interfaces with KEF LSX over UPnP
 */

const { Player, Constants } = require('yt-cast-receiver');
const KefUpnpClient = require('./kef-upnp');

class KefPlayer extends Player {
  constructor(options = {}) {
    super();
    this.kefIp = options.kefIp || process.env.KEF_IP;
    if (!this.kefIp) {
      throw new Error('KEF speaker IP is required (options.kefIp or KEF_IP environment variable).');
    }
    this.kefPort = options.kefPort || parseInt(process.env.KEF_PORT, 10) || 8080;
    this.streamPort = options.streamPort || 8099;
    this.serverHost = options.serverHost || '127.0.0.1';
    this.streamServer = options.streamServer;

    this.kef = new KefUpnpClient(this.kefIp, this.kefPort);

    this.currentVideo = null;
    this.currentDuration = 0;
    this.currentPosition = 0;
    this.pollInterval = null;
    this.isPlaying = false;
  }

  setServerHost(host) {
    this.serverHost = host;
  }

  async doPlay(video, position = 0) {
    try {
      this.currentVideo = video;
      console.log(`\n🎵 [KEF Player] Loading track: https://youtube.com/watch?v=${video.id} (Start position: ${position}s)`);

      // 1. Fetch track metadata
      let meta = null;
      if (this.streamServer) {
        meta = await this.streamServer.fetchVideoMeta(video.id).catch(() => null);
      }

      const title = meta ? meta.title : `YouTube Track (${video.id})`;
      const artist = meta ? meta.artist : 'YouTube Music';
      const album = meta ? meta.album : '';
      const thumbnail = meta ? meta.thumbnail : '';
      this.currentDuration = meta ? meta.duration : 0;
      this.currentPosition = position;

      console.log(`🎶 [KEF Player] Now Playing: "${title}" by "${artist}" [${this.formatDuration(this.currentDuration)}]`);

      // 2. Build local stream URL and DIDL-Lite metadata
      const streamUrl = `http://${this.serverHost}:${this.streamPort}/stream/${video.id}.mp3${position > 0 ? `?pos=${position}` : ''}`;
      console.log(`[KEF Player] Audio Stream URL: ${streamUrl}`);
      const didl = this.kef.createDIDL(title, artist, album, thumbnail, streamUrl);

      // 3. Send UPnP commands to KEF LSX
      await this.kef.setAVTransportURI(streamUrl, didl);
      await this.kef.play();

      this.isPlaying = true;
      this.startPolling();

      return true;
    } catch (err) {
      console.error('[KEF Player] Play error:', err.message);
      return false;
    }
  }

  async doPause() {
    try {
      console.log('[KEF Player] Pausing playback...');
      this.isPlaying = false;

      // Stop active ffmpeg streaming
      if (this.streamServer) {
        this.streamServer.stopStream();
      }

      await this.kef.pause();
      return true;
    } catch (err) {
      console.warn('[KEF Player] Pause error handled:', err.message);
      await this.kef.stop().catch(() => { });
      return true;
    }
  }

  async doResume() {
    try {
      console.log(`[KEF Player] Resuming playback from ${this.currentPosition}s...`);
      if (this.currentVideo) {
        return await this.doPlay(this.currentVideo, this.currentPosition);
      }
      await this.kef.play();
      this.isPlaying = true;
      return true;
    } catch (err) {
      console.error('[KEF Player] Resume error:', err.message);
      return false;
    }
  }

  async doStop() {
    try {
      console.log('⏹️ [KEF Player] Stopping playback...');
      this.stopPolling();
      if (this.streamServer) {
        this.streamServer.stopStream();
      }
      await this.kef.stop().catch(() => { });
      this.isPlaying = false;
      this.currentPosition = 0;
      return true;
    } catch (err) {
      console.error('[KEF Player] Stop error:', err.message);
      return false;
    }
  }

  async doSeek(position) {
    try {
      console.log(`[KEF Player] Seeking to ${position}s...`);
      this.currentPosition = position;
      if (this.currentVideo) {
        return await this.doPlay(this.currentVideo, position);
      }
      await this.kef.seek(position);
      return true;
    } catch (err) {
      if (this.currentVideo) {
        return await this.doPlay(this.currentVideo, position);
      }
      return false;
    }
  }

  async doSetVolume(volume) {
    try {
      console.log(`[KEF Player] Setting volume to ${volume.level}% (Muted: ${volume.muted})`);
      if (volume.level !== undefined) {
        await this.kef.setVolume(volume.level);
      }
      if (volume.muted !== undefined) {
        await this.kef.setMute(volume.muted);
      }
      return true;
    } catch (err) {
      console.error('[KEF Player] Volume error:', err.message);
      return false;
    }
  }

  async doGetVolume() {
    try {
      const level = await this.kef.getVolume();
      const muted = await this.kef.getMute();
      return { level, muted };
    } catch (err) {
      return { level: 50, muted: false };
    }
  }

  async doGetPosition() {
    return this.currentPosition;
  }

  async doGetDuration() {
    return this.currentDuration;
  }

  startPolling() {
    this.stopPolling();
    this.pollInterval = setInterval(async () => {
      if (!this.isPlaying) return;

      this.currentPosition += 1;

      try {
        const info = await this.kef.getTransportInfo();
        const pos = await this.kef.getPositionInfo();

        if (pos && pos.position > 0) {
          this.currentPosition = pos.position;
        }

        // Check if song finished playing
        if (info.state === 'STOPPED' && this.isPlaying) {
          if (this.currentDuration > 0 && this.currentPosition >= this.currentDuration - 3) {
            console.log('⏭️ [KEF Player] Track finished. Advancing to next track in queue...');
            this.isPlaying = false;
            this.stopPolling();
            await this.next();
          }
        }
      } catch (e) { }
    }, 1000);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }
}

module.exports = KefPlayer;
