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
    this.streamStartPosition = 0;
    this.playbackStartTime = 0;
    this.pollTimer = null;
    this.isPolling = false;
    this.isPlaying = false;
    this.autoStopOnSpeakerOff = options.autoStopOnSpeakerOff !== undefined ? options.autoStopOnSpeakerOff : true;
    this.consecutivePollErrors = 0;
    this.consecutiveStopped = 0;
    this.playStartTime = 0;
  }

  setServerHost(host) {
    this.serverHost = host;
  }

  async doPlay(video, position = 0) {
    try {
      // 1. Immediately stop any active polling to prevent false "speaker stopped" during seek/load
      this.stopPolling();
      this.isPlaying = false;

      this.currentVideo = video;
      this.streamStartPosition = position;
      this.currentPosition = position;
      this.consecutiveStopped = 0;
      this.playStartTime = Date.now();
      this.playbackStartTime = Date.now();
      if (this.streamServer) {
        this.streamServer.resetStreamEnded();
      }

      console.log(`\n[KEF Player] Loading track: https://youtube.com/watch?v=${video.id} (Start position: ${position}s)`);

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
      this.streamStartPosition = position;

      console.log(`[KEF Player] Now Playing: "${title}" by "${artist}" [${this.formatDuration(this.currentDuration)}]`);

      // 2. Build local stream URL and DIDL-Lite metadata
      const streamUrl = `http://${this.serverHost}:${this.streamPort}/stream/${video.id}.mp3${position > 0 ? `?pos=${position}` : ''}`;
      console.log(`[KEF Player] Audio Stream URL: ${streamUrl}`);
      const didl = this.kef.createDIDL(title, artist, album, thumbnail, streamUrl);

      // 3. Send UPnP commands to KEF LSX
      await this.kef.setAVTransportURI(streamUrl, didl);
      await this.kef.play();

      this.isPlaying = true;
      this.consecutivePollErrors = 0;
      this.consecutiveStopped = 0;

      // 4. Wait for audio to actively start streaming and KEF to enter PLAYING state
      // (Keeps YouTube Music in native LOADING spinner at 0:00 until audio actually starts)
      await this.waitForPlaybackStart(6000);

      this.playStartTime = Date.now();
      this.playbackStartTime = Date.now();
      this.startPolling();

      return true;
    } catch (err) {
      console.error('[KEF Player] Play error:', err.message);
      this.isPlaying = false;
      this.stopPolling();
      return false;
    }
  }

  async waitForPlaybackStart(timeoutMs = 6000) {
    const startTime = Date.now();

    // 1. Wait for streamServer to start pumping audio chunks
    if (this.streamServer) {
      await this.streamServer.waitForStreaming(timeoutMs);
    }

    // 2. Poll KEF speaker state until it transitions to PLAYING
    const remainingTime = Math.max(1000, timeoutMs - (Date.now() - startTime));
    const speakerWaitStart = Date.now();

    while (Date.now() - speakerWaitStart < remainingTime) {
      try {
        const info = await this.kef.getTransportInfo();
        if (info && info.state === 'PLAYING') {
          return true;
        }
      } catch (e) { }
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    return true;
  }

  async doPause() {
    try {
      console.log('[KEF Player] Pausing playback...');
      this.isPlaying = false;
      this.stopPolling();

      // Pause speaker playback (kef.pause automatically falls back to stop for live/chunked streams)
      try {
        await this.kef.pause();
      } catch (err) {
        console.warn('[KEF Player] Speaker pause failed, stopping speaker:', err.message);
        await this.kef.stop().catch(() => { });
      }

      // Stop active transcoding and network stream
      if (this.streamServer) {
        this.streamServer.stopStream();
        this.streamServer.resetStreamEnded();
      }

      return true;
    } catch (err) {
      console.warn('[KEF Player] Pause error handled:', err.message);
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
      console.log('[KEF Player] Stopping playback...');
      this.stopPolling();
      await this.kef.stop().catch(() => { });
      if (this.streamServer) {
        this.streamServer.stopStream();
        this.streamServer.resetStreamEnded();
      }
      this.isPlaying = false;
      this.currentPosition = 0;
      this.streamStartPosition = 0;
      this.playbackStartTime = 0;
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
      this.streamStartPosition = position;
      this.playbackStartTime = Date.now();
      if (this.streamServer) {
        this.streamServer.resetStreamEnded();
      }
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
    if (this.isPlaying && this.playbackStartTime > 0) {
      const elapsed = Math.max(0, Math.floor((Date.now() - this.playbackStartTime) / 1000));
      let pos = this.streamStartPosition + elapsed;
      if (this.currentDuration > 0) {
        pos = Math.min(pos, this.currentDuration);
      }
      return pos;
    }
    return this.currentPosition;
  }

  async doGetDuration() {
    return this.currentDuration;
  }

  startPolling() {
    this.stopPolling();
    this.consecutivePollErrors = 0;
    this.consecutiveStopped = 0;

    const poll = async () => {
      if (!this.isPlaying) return;
      if (this.isPolling) return;
      this.isPolling = true;

      try {
        await this.pollSpeaker();
      } catch (err) {
        console.warn('[KEF Player] Unexpected poll error:', err.message);
      } finally {
        this.isPolling = false;
        if (this.isPlaying) {
          this.pollTimer = setTimeout(poll, 1000);
        }
      }
    };

    this.pollTimer = setTimeout(poll, 1000);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.isPolling = false;
  }

  async pollSpeaker() {
    if (!this.isPlaying) return;

    let info = null;
    try {
      info = await this.kef.getTransportInfo();
    } catch (e) {
      info = { state: 'ERROR', error: e.message };
    }

    if (info && (info.state === 'ERROR' || info.error)) {
      this.consecutivePollErrors += 1;
      if (this.autoStopOnSpeakerOff && this.consecutivePollErrors >= 3 && this.isPlaying) {
        console.warn(`[KEF Player] Speaker unreachable (${this.consecutivePollErrors} consecutive timeouts). Speaker was turned off or lost connection.`);
        console.log('[KEF Player] Stopping playback and notifying sender...');
        this.isPlaying = false;
        this.stopPolling();
        if (this.streamServer) {
          this.streamServer.stopStream();
        }
        await this.stop();
      }
      return;
    }

    // Reset error count on successful communication
    this.consecutivePollErrors = 0;

    // Track stream/playback status
    const streamEnded = this.streamServer ? this.streamServer.hasStreamEnded() : false;

    // Position tracking: query speaker position if PLAYING, fallback to wall clock
    if (info && info.state === 'PLAYING') {
      this.consecutiveStopped = 0;

      let speakerPos = null;
      try {
        const pos = await this.kef.getPositionInfo();
        if (pos && typeof pos.position === 'number' && pos.position > 0) {
          speakerPos = pos.position;
        }
      } catch (e) {
        // Safe to ignore: getPositionInfo can fail on chunked streams
      }

      if (speakerPos !== null) {
        this.currentPosition = this.streamStartPosition + speakerPos;
        // Re-synchronize playbackStartTime with speaker position
        this.playbackStartTime = Date.now() - (speakerPos * 1000);
      } else {
        // Fallback to wall-clock elapsed time from playback start
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.playbackStartTime) / 1000));
        this.currentPosition = this.streamStartPosition + elapsedSeconds;
      }

      if (this.currentDuration > 0) {
        this.currentPosition = Math.min(this.currentPosition, this.currentDuration);
      }

      // Check if track duration + buffer has completed while still reporting PLAYING
      if (this.currentDuration > 0 && this.currentPosition >= this.currentDuration && streamEnded) {
        console.log('[KEF Player] Track stream finished and duration reached. Advancing to next track in queue...');
        this.isPlaying = false;
        this.stopPolling();
        if (this.streamServer) {
          this.streamServer.stopStream();
          this.streamServer.resetStreamEnded();
        }
        try {
          const advanced = await this.next();
          if (!advanced) {
            console.log('[KEF Player] End of queue reached or no next video available.');
          }
        } catch (nextErr) {
          console.error('[KEF Player] Error advancing to next track:', nextErr.message);
          await this.stop().catch(() => {});
        }
        return;
      }
    }

    // Check speaker playback state
    const isStopped = info && (info.state === 'STOPPED' || info.state === 'NO_MEDIA_PRESENT');
    if (isStopped && this.isPlaying) {
      const reachedDuration = this.currentDuration > 0 && this.currentPosition >= Math.max(0, this.currentDuration - 5);
      const effectiveElapsed = ((Date.now() - this.playStartTime) / 1000) + this.streamStartPosition;
      const reachedTime = this.currentDuration > 0 && effectiveElapsed >= Math.max(0, this.currentDuration - 5);
      const isTrackEnd = streamEnded || reachedDuration || reachedTime;

      if (isTrackEnd) {
        console.log(`[KEF Player] Track finished (${streamEnded ? 'stream ended' : 'duration reached'}). Advancing to next track in queue...`);
        this.isPlaying = false;
        this.stopPolling();
        if (this.streamServer) {
          this.streamServer.stopStream();
          this.streamServer.resetStreamEnded();
        }
        try {
          const advanced = await this.next();
          if (!advanced) {
            console.log('[KEF Player] End of queue reached or no next video available.');
          }
        } catch (nextErr) {
          console.error('[KEF Player] Error advancing to next track:', nextErr.message);
          await this.stop().catch(() => {});
        }
        return;
      } else if (this.autoStopOnSpeakerOff && Date.now() - this.playStartTime > 5000) {
        // Speaker is STOPPED during middle of track - require 3 consecutive checks (3s) to avoid buffering race
        this.consecutiveStopped += 1;
        if (this.consecutiveStopped >= 3 && this.isPlaying) {
          console.log('[KEF Player] Speaker stopped externally or source switched. Stopping playback and notifying sender...');
          this.isPlaying = false;
          this.stopPolling();
          if (this.streamServer) {
            this.streamServer.stopStream();
          }
          await this.stop();
        }
      }
    } else if (info && info.state === 'PAUSED_PLAYBACK' && this.isPlaying && this.autoStopOnSpeakerOff) {
      this.consecutiveStopped = 0;
      console.log('[KEF Player] Speaker paused externally. Notifying sender...');
      this.isPlaying = false;
      this.stopPolling();
      if (this.streamServer) {
        this.streamServer.stopStream();
      }
      await this.pause();
    } else if (info && info.state === 'TRANSITIONING') {
      this.consecutiveStopped = 0;
    }
  }

  formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }
}

module.exports = KefPlayer;
