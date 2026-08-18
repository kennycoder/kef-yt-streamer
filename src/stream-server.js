/**
 * Local HTTP Audio Streaming Server
 * Streams YouTube audio directly to DLNA renderers as clean MP3
 */

const http = require('http');
const { spawn, execFile } = require('child_process');

class StreamServer {
  constructor(options = {}) {
    this.port = options.port || 8099;
    this.ytdlpPath = options.ytdlpPath || 'yt-dlp';
    this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
    this.server = null;
    this.currentFfmpegProc = null;
    this.currentYtdlpProc = null;
    this.currentResponse = null;
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
    if (this.currentYtdlpProc) {
      try { this.currentYtdlpProc.kill('SIGTERM'); } catch (e) { }
      this.currentYtdlpProc = null;
    }
    if (this.currentFfmpegProc) {
      try { this.currentFfmpegProc.kill('SIGTERM'); } catch (e) { }
      this.currentFfmpegProc = null;
    }
    if (this.currentResponse && !this.currentResponse.writableEnded) {
      try { this.currentResponse.end(); } catch (e) { }
      this.currentResponse = null;
    }
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
        '--extractor-args', 'youtube:player_client=android,web',
        '-f', 'bestaudio[ext=m4a]/ba/b',
        `https://www.youtube.com/watch?v=${videoId}`
      ];

      execFile(this.ytdlpPath, args, { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) return reject(err);
        try {
          const data = JSON.parse(stdout);
          const meta = {
            id: data.id,
            title: data.title || 'Unknown Title',
            artist: data.artist || data.uploader || data.channel || 'Unknown Artist',
            album: data.album || '',
            duration: data.duration || 0,
            thumbnail: data.thumbnail || '',
            streamUrl: data.url
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
      const videoId = urlParts[2].replace(/\.(mp3|m4a|wav|aac)$/, '');
      const urlParams = new URL(req.url, `http://localhost:${this.port}`).searchParams;
      const startPos = parseInt(urlParams.get('pos') || '0', 10);

      try {
        const meta = await this.fetchVideoMeta(videoId);

        // Terminate any previous active stream
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

        // Pipeline: yt-dlp with android client args piped directly to ffmpeg
        const ytdlpArgs = [
          '-o', '-',
          '-q',
          '--no-playlist',
          '--extractor-args', 'youtube:player_client=android,web',
          '-f', 'bestaudio[ext=m4a]/ba/b',
          `https://www.youtube.com/watch?v=${videoId}`
        ];

        const ytdlp = spawn(this.ytdlpPath, ytdlpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.currentYtdlpProc = ytdlp;

        const ffmpegArgs = [];
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

        const ffmpeg = spawn(this.ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'pipe', 'ignore'] });
        this.currentFfmpegProc = ffmpeg;

        ytdlp.stdout.pipe(ffmpeg.stdin);
        ffmpeg.stdout.pipe(res);

        ytdlp.stderr.on('data', (d) => {
          // Log any extraction warnings
          const msg = d.toString();
          if (msg.includes('ERROR')) console.error('[yt-dlp]', msg.trim());
        });

        const cleanup = () => {
          if (this.currentYtdlpProc === ytdlp) {
            try { ytdlp.kill('SIGTERM'); } catch (e) { }
            this.currentYtdlpProc = null;
          }
          if (this.currentFfmpegProc === ffmpeg) {
            try { ffmpeg.kill('SIGTERM'); } catch (e) { }
            this.currentFfmpegProc = null;
          }
          if (this.currentResponse === res) {
            this.currentResponse = null;
          }
        };

        req.on('close', cleanup);
        ffmpeg.on('close', cleanup);
        ytdlp.on('close', () => {
          try { ffmpeg.stdin.end(); } catch (e) { }
        });

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
