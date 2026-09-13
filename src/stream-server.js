/**
 * Local HTTP Audio Streaming Server
 * Streams YouTube audio directly to DLNA renderers as clean MP3
 */

const http = require('http');
const EventEmitter = require('events');
const { spawn, execFile } = require('child_process');

class StreamServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 8099;
    this.ytdlpPath = options.ytdlpPath || 'yt-dlp';
    this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
    this.server = null;
    this.currentFfmpegProc = null;
    this.currentYtdlpProc = null;
    this.currentResponse = null;
    this.isCurrentlyStreaming = false;
    this.metaCache = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.handleRequest.bind(this));
      this.server.on('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => {
        resolve(this.port);
      });
    });
  }

  stopStream() {
    const ytdlp = this.currentYtdlpProc;
    const ffmpeg = this.currentFfmpegProc;
    const res = this.currentResponse;

    this.currentYtdlpProc = null;
    this.currentFfmpegProc = null;
    this.currentResponse = null;

    this.isCurrentlyStreaming = false;

    if (ytdlp) {
      try {
        if (ytdlp.stdout) {
          ytdlp.stdout.unpipe();
          ytdlp.stdout.destroy();
        }
        ytdlp.kill('SIGTERM');
      } catch (e) { }
    }

    if (ffmpeg) {
      try {
        if (ffmpeg.stdin) {
          ffmpeg.stdin.destroy();
        }
        if (ffmpeg.stdout) {
          ffmpeg.stdout.unpipe();
          ffmpeg.stdout.destroy();
        }
        ffmpeg.kill('SIGTERM');
      } catch (e) { }
    }

    if (res && !res.writableEnded) {
      try {
        res.end();
      } catch (e) { }
    }
  }

  waitForStreaming(timeoutMs = 6000) {
    if (this.isCurrentlyStreaming) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeListener('streaming', onStreaming);
        resolve(false);
      }, timeoutMs);

      const onStreaming = () => {
        clearTimeout(timer);
        resolve(true);
      };

      this.once('streaming', onStreaming);
    });
  }

  stop() {
    this.stopStream();
    if (this.server) {
      this.server.close();
    }
  }

  async fetchVideoMeta(videoId) {
    if (this.metaCache.has(videoId)) {
      return this.metaCache.get(videoId);
    }

    return new Promise((resolve, reject) => {
      const args = [
        '-j',
        '--no-playlist',
        '--extractor-args', 'youtube:player_client=android',
        '-f', 'bestaudio[ext=m4a]/ba/b',
        `https://www.youtube.com/watch?v=${videoId}`
      ];

      execFile(this.ytdlpPath, args, { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) return reject(err);
        try {
          const data = JSON.parse(stdout);
          let httpHeaders = '';
          if (data.http_headers) {
            httpHeaders = Object.entries(data.http_headers)
              .map(([k, v]) => `${k}: ${v}\r\n`)
              .join('');
          }
          const meta = {
            id: data.id,
            title: data.title || 'Unknown Title',
            artist: data.artist || data.uploader || data.channel || 'Unknown Artist',
            album: data.album || '',
            duration: data.duration || 0,
            thumbnail: data.thumbnail || '',
            streamUrl: data.url,
            httpHeaders
          };
          this.metaCache.set(videoId, meta);
          resolve(meta);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  async handleRequest(req, res) {
    console.log(`[StreamServer] HTTP ${req.method} ${req.url} from ${req.socket.remoteAddress}`);

    const urlParts = req.url.split('?')[0].split('/');
    if (urlParts[1] === 'stream' && urlParts[2]) {
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Accept-Ranges': 'none',
          'Server': 'KefYtStreamServer/1.0',
          'Connection': 'close'
        });
        res.end();
        return;
      }

      const videoId = urlParts[2].replace(/\.(mp3|m4a|wav|aac)$/, '');
      const urlParams = new URL(req.url, `http://localhost:${this.port}`).searchParams;
      const startPos = parseInt(urlParams.get('pos') || '0', 10);

      try {
        const meta = await this.fetchVideoMeta(videoId);

        // Terminate any previous active stream cleanly
        this.stopStream();
        this.currentResponse = res;

        console.log(`[StreamServer] Streaming "${meta.title}" (${meta.artist}) to speaker...`);

        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Accept-Ranges': 'none',
          'Server': 'KefYtStreamServer/1.0',
          'Connection': 'close',
          'icy-name': `${meta.artist} - ${meta.title}`
        });

        const ffmpegArgs = [];
        const useDirectUrl = Boolean(meta.streamUrl);
        let ytdlp = null;

        if (useDirectUrl) {
          // Fast path: Stream direct audio CDN URL with FFmpeg, avoiding second yt-dlp process
          if (meta.httpHeaders) {
            ffmpegArgs.push('-headers', meta.httpHeaders);
          }
          if (startPos > 0) {
            ffmpegArgs.push('-ss', String(startPos));
          }
          ffmpegArgs.push(
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-i', meta.streamUrl,
            '-vn',
            '-acodec', 'libmp3lame',
            '-b:a', '320k',
            '-ar', '44100',
            '-ac', '2',
            '-f', 'mp3',
            'pipe:1'
          );
        } else {
          // Fallback pipeline: yt-dlp piped into ffmpeg
          const ytdlpArgs = [
            '-o', '-',
            '-q',
            '--no-playlist',
            '--extractor-args', 'youtube:player_client=android',
            '-f', 'bestaudio[ext=m4a]/ba/b',
            `https://www.youtube.com/watch?v=${videoId}`
          ];

          ytdlp = spawn(this.ytdlpPath, ytdlpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
          this.currentYtdlpProc = ytdlp;

          ytdlp.on('error', (err) => {
            if (err.code !== 'EPIPE') console.warn('[StreamServer] yt-dlp error:', err.message);
          });
          if (ytdlp.stdout) {
            ytdlp.stdout.on('error', () => { });
          }

          ytdlp.stderr.on('data', (d) => {
            const msg = d.toString();
            if (msg.includes('ERROR')) console.error('[yt-dlp]', msg.trim());
          });

          if (startPos > 0) {
            ffmpegArgs.push('-ss', String(startPos));
          }

          ffmpegArgs.push(
            '-i', 'pipe:0',
            '-vn',
            '-acodec', 'libmp3lame',
            '-b:a', '320k',
            '-ar', '44100',
            '-ac', '2',
            '-f', 'mp3',
            'pipe:1'
          );
        }

        const ffmpeg = spawn(this.ffmpegPath, ffmpegArgs, { stdio: [useDirectUrl ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
        this.currentFfmpegProc = ffmpeg;

        ffmpeg.on('error', (err) => {
          if (err.code !== 'EPIPE') console.warn('[StreamServer] ffmpeg error:', err.message);
        });
        if (ffmpeg.stdin) {
          ffmpeg.stdin.on('error', () => { });
        }
        if (ffmpeg.stdout) {
          ffmpeg.stdout.on('error', () => { });
        }

        res.on('error', (err) => {
          if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
            console.warn('[StreamServer] Response socket error:', err.message);
          }
        });
        req.on('error', () => { });
        if (req.socket) {
          req.socket.on('error', () => { });
        }

        let streamNotified = false;
        ffmpeg.stdout.on('data', () => {
          if (!streamNotified) {
            streamNotified = true;
            this.isCurrentlyStreaming = true;
            this.emit('streaming', { videoId, startPos });
          }
        });

        if (!useDirectUrl && this.currentYtdlpProc) {
          this.currentYtdlpProc.stdout.pipe(ffmpeg.stdin);
          this.currentYtdlpProc.on('close', () => {
            try {
              if (ffmpeg.stdin && !ffmpeg.stdin.destroyed && ffmpeg.stdin.writable) {
                ffmpeg.stdin.end();
              }
            } catch (e) { }
          });
        }

        ffmpeg.stdout.pipe(res);

        const cleanup = () => {
          if ((ytdlp && this.currentYtdlpProc === ytdlp) || this.currentFfmpegProc === ffmpeg || this.currentResponse === res) {
            this.stopStream();
          }
        };

        req.on('close', cleanup);
        ffmpeg.on('close', cleanup);

      } catch (err) {
        console.error(`[StreamServer] Error streaming video ${videoId}:`, err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
        }
        res.end('Error streaming audio');
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }
}

module.exports = StreamServer;
