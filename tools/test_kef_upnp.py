import os
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET

import sys

KEF_IP = os.getenv("KEF_IP")
if not KEF_IP:
    print("Error: KEF_IP environment variable is not set. Example: KEF_IP=192.168.0.10 python tools/test_kef_upnp.py", file=sys.stderr)
    sys.exit(1)

KEF_PORT = int(os.getenv("KEF_PORT", "8080"))

def send_soap(service_url, service_type, action, args={}):
    args_xml = "".join([f"<{k}>{v}</{k}>" for k, v in args.items()])
    body = f"""<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:{action} xmlns:u="{service_type}">
      {args_xml}
    </u:{action}>
  </s:Body>
</s:Envelope>"""

    headers = {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': f'"{service_type}#{action}"'
    }

    url = f"http://{KEF_IP}:{KEF_PORT}{service_url}"
    req = urllib.request.Request(url, data=body.encode('utf-8'), headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            data = resp.read().decode('utf-8')
            return True, data
    except urllib.error.HTTPError as e:
        return False, e.read().decode('utf-8')
    except Exception as e:
        return False, str(e)

print("1. Testing GetVolume from RenderingControl:")
ok, res = send_soap(
    "/RenderingControl/ctrl",
    "urn:schemas-upnp-org:service:RenderingControl:1",
    "GetVolume",
    {"InstanceID": "0", "Channel": "Master"}
)
print("Result:", ok, res)

print("\n2. Testing GetTransportInfo from AVTransport:")
ok, res = send_soap(
    "/AVTransport/ctrl",
    "urn:schemas-upnp-org:service:AVTransport:1",
    "GetTransportInfo",
    {"InstanceID": "0"}
)
print("Result:", ok, res)

print("\n3. Testing GetPositionInfo from AVTransport:")
ok, res = send_soap(
    "/AVTransport/ctrl",
    "urn:schemas-upnp-org:service:AVTransport:1",
    "GetPositionInfo",
    {"InstanceID": "0"}
)
print("Result:", ok, res)
