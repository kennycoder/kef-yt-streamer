import os
import http.client
import urllib.parse
import xml.etree.ElementTree as ET
import html
import time

import sys

KEF_IP = os.getenv("KEF_IP")
if not KEF_IP:
    print("Error: KEF_IP environment variable is not set. Example: KEF_IP=192.168.0.10 python tools/kef_upnp_client.py", file=sys.stderr)
    sys.exit(1)

KEF_PORT = int(os.getenv("KEF_PORT", "8080"))

def send_soap(service_path, service_type, action, args):
    args_xml = "".join([f"<{k}>{html.escape(str(v))}</{k}>" for k, v in args.items()])
    soap_body = f"""<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:{action} xmlns:u="{service_type}">
      {args_xml}
    </u:{action}>
  </s:Body>
</s:Envelope>"""

    headers = {
        "Content-Type": 'text/xml; charset="utf-8"',
        "SOAPAction": f'"{service_type}#{action}"',
        "Content-Length": str(len(soap_body.encode('utf-8')))
    }

    conn = http.client.HTTPConnection(KEF_IP, KEF_PORT, timeout=5)
    conn.request("POST", service_path, body=soap_body.encode('utf-8'), headers=headers)
    resp = conn.getresponse()
    body = resp.read().decode('utf-8', errors='ignore')
    conn.close()
    return resp.status == 200, body

# Test setting volume to current volume (safe test)
ok, res = send_soap(
    "/RenderingControl/ctrl",
    "urn:schemas-upnp-org:service:RenderingControl:1",
    "GetVolume",
    {"InstanceID": "0", "Channel": "Master"}
)
print("GetVolume result:", ok)

# Parse volume
root = ET.fromstring(res)
vol_el = root.find(".//CurrentVolume")
if vol_el is not None:
    vol = int(vol_el.text)
    print(f"Current KEF LSX volume: {vol}")
