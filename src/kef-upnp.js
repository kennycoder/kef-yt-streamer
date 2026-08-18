/**
 * UPnP / DLNA Controller for KEF LSX
 */

const http = require('http');

class KefUpnpClient {
  constructor(ip = process.env.KEF_IP, port = parseInt(process.env.KEF_PORT, 10) || 8080) {
    if (!ip) {
      throw new Error('KEF speaker IP is required (constructor argument or KEF_IP environment variable).');
    }
    this.ip = ip;
    this.port = port;
  }

  async sendSoap(servicePath, serviceType, action, args = {}) {
    let argsXml = '';
    for (const [key, val] of Object.entries(args)) {
      const escaped = String(val == null ? '' : val)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
      argsXml += `<${key}>${escaped}</${key}>`;
    }

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${serviceType}">
      {argsXml}
    </u:${action}>
  </s:Body>
</s:Envelope>`.replace('{argsXml}', argsXml);

    const headers = {
      'Content-Type': 'text/xml; charset="utf-8"',
      'SOAPAction': `"${serviceType}#${action}"`,
      'Content-Length': Buffer.byteLength(soapBody, 'utf8')
    };

    return new Promise((resolve, reject) => {
      const req = http.request({
        host: this.ip,
        port: this.port,
        path: servicePath,
        method: 'POST',
        headers,
        timeout: 4000
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`SOAP HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('SOAP request timed out'));
      });

      req.write(soapBody);
      req.end();
    });
  }

  // --- AVTransport Actions ---

  async setAVTransportURI(uri, metadataXml = '') {
    return this.sendSoap(
      '/AVTransport/ctrl',
      'urn:schemas-upnp-org:service:AVTransport:1',
      'SetAVTransportURI',
      {
        InstanceID: 0,
        CurrentURI: uri,
        CurrentURIMetaData: metadataXml
      }
    );
  }

  async play() {
    return this.sendSoap(
      '/AVTransport/ctrl',
      'urn:schemas-upnp-org:service:AVTransport:1',
      'Play',
      {
        InstanceID: 0,
        Speed: '1'
      }
    );
  }

  async pause() {
    try {
      return await this.sendSoap(
        '/AVTransport/ctrl',
        'urn:schemas-upnp-org:service:AVTransport:1',
        'Pause',
        { InstanceID: 0 }
      );
    } catch (err) {
      if (err.message.includes('701') || err.message.includes('Transition not available')) {
        // Speaker cannot pause live stream, fallback to stop
        return await this.stop();
      }
      throw err;
    }
  }

  async stop() {
    return this.sendSoap(
      '/AVTransport/ctrl',
      'urn:schemas-upnp-org:service:AVTransport:1',
      'Stop',
      { InstanceID: 0 }
    );
  }

  async seek(seconds) {
    const target = this.formatTime(seconds);
    return this.sendSoap(
      '/AVTransport/ctrl',
      'urn:schemas-upnp-org:service:AVTransport:1',
      'Seek',
      {
        InstanceID: 0,
        Unit: 'REL_TIME',
        Target: target
      }
    );
  }

  async getTransportInfo() {
    try {
      const xml = await this.sendSoap(
        '/AVTransport/ctrl',
        'urn:schemas-upnp-org:service:AVTransport:1',
        'GetTransportInfo',
        { InstanceID: 0 }
      );
      const stateMatch = xml.match(/<CurrentTransportState>([^<]+)<\/CurrentTransportState>/);
      const statusMatch = xml.match(/<CurrentTransportStatus>([^<]+)<\/CurrentTransportStatus>/);
      return {
        state: stateMatch ? stateMatch[1] : 'UNKNOWN',
        status: statusMatch ? statusMatch[1] : 'UNKNOWN'
      };
    } catch (e) {
      return { state: 'ERROR', error: e.message };
    }
  }

  async getPositionInfo() {
    try {
      const xml = await this.sendSoap(
        '/AVTransport/ctrl',
        'urn:schemas-upnp-org:service:AVTransport:1',
        'GetPositionInfo',
        { InstanceID: 0 }
      );
      const durationMatch = xml.match(/<TrackDuration>([^<]+)<\/TrackDuration>/);
      const relTimeMatch = xml.match(/<RelTime>([^<]+)<\/RelTime>/);
      const trackUriMatch = xml.match(/<TrackURI>([^<]+)<\/TrackURI>/);

      const durationStr = durationMatch ? durationMatch[1] : '0:00:00';
      const relTimeStr = relTimeMatch ? relTimeMatch[1] : '0:00:00';

      return {
        duration: this.parseTime(durationStr),
        position: this.parseTime(relTimeStr),
        uri: trackUriMatch ? trackUriMatch[1] : ''
      };
    } catch (e) {
      return { duration: 0, position: 0, error: e.message };
    }
  }

  // --- RenderingControl Actions ---

  async getVolume() {
    try {
      const xml = await this.sendSoap(
        '/RenderingControl/ctrl',
        'urn:schemas-upnp-org:service:RenderingControl:1',
        'GetVolume',
        {
          InstanceID: 0,
          Channel: 'Master'
        }
      );
      const volMatch = xml.match(/<CurrentVolume>([^<]+)<\/CurrentVolume>/);
      return volMatch ? parseInt(volMatch[1], 10) : 50;
    } catch (e) {
      return 50;
    }
  }

  async setVolume(volume) {
    const vol = Math.max(0, Math.min(100, Math.round(volume)));
    return this.sendSoap(
      '/RenderingControl/ctrl',
      'urn:schemas-upnp-org:service:RenderingControl:1',
      'SetVolume',
      {
        InstanceID: 0,
        Channel: 'Master',
        DesiredVolume: vol
      }
    );
  }

  async getMute() {
    try {
      const xml = await this.sendSoap(
        '/RenderingControl/ctrl',
        'urn:schemas-upnp-org:service:RenderingControl:1',
        'GetMute',
        {
          InstanceID: 0,
          Channel: 'Master'
        }
      );
      const muteMatch = xml.match(/<CurrentMute>([^<]+)<\/CurrentMute>/);
      return muteMatch ? muteMatch[1] === '1' || muteMatch[1].toLowerCase() === 'true' : false;
    } catch (e) {
      return false;
    }
  }

  async setMute(muted) {
    return this.sendSoap(
      '/RenderingControl/ctrl',
      'urn:schemas-upnp-org:service:RenderingControl:1',
      'SetMute',
      {
        InstanceID: 0,
        Channel: 'Master',
        DesiredMute: muted ? '1' : '0'
      }
    );
  }

  // --- DIDL-Lite Metadata Generator ---

  createDIDL(title, artist = '', album = '', artUrl = '', mediaUrl = '') {
    const escapeXml = (s) => String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

    return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <item id="1" parentID="0" restricted="1">
    <dc:title>${escapeXml(title)}</dc:title>
    ${artist ? `<dc:creator>${escapeXml(artist)}</dc:creator><upnp:artist>${escapeXml(artist)}</upnp:artist>` : ''}
    ${album ? `<upnp:album>${escapeXml(album)}</upnp:album>` : ''}
    <upnp:class>object.item.audioItem.musicTrack</upnp:class>
    ${artUrl ? `<upnp:albumArtURI>${escapeXml(artUrl)}</upnp:albumArtURI>` : ''}
    ${mediaUrl ? `<res protocolInfo="http-get:*:audio/mpeg:*">${escapeXml(mediaUrl)}</res>` : ''}
  </item>
</DIDL-Lite>`;
  }

  // --- Time Helpers ---

  formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  parseTime(timeStr) {
    if (!timeStr || timeStr === '0' || timeStr === 'NOT_IMPLEMENTED') return 0;
    const parts = timeStr.split(':').map(Number);
    if (parts.length === 3) {
      return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
    }
    if (parts.length === 2) {
      return (parts[0] * 60) + parts[1];
    }
    return 0;
  }
}

module.exports = KefUpnpClient;
