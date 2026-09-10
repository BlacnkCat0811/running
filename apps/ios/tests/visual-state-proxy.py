#!/usr/bin/env python3
"""Loopback-only UI fault injection. GET forwards to an isolated API; writes never do.

Port 8793: normal/offline/empty/handshake-error/handshake-delay/lock-preview.
Port 8794: cold loading screenshot. POST /__mode accepts {"mode": "..."}.
No endpoint or scoring logic in the production app is replaced.
"""
import json
import threading
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BACKEND = 'http://127.0.0.1:8792'
MODES = {8793: 'normal', 8794: 'loading'}
ALLOWED = {'normal', 'offline', 'empty', 'handshake-error', 'handshake-delay', 'lock-preview', 'loading'}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        if self.path != '/__mode':
            self.respond(405, {'code': 'visual_read_only', 'message': '视觉验收代理禁止业务写入'})
            return
        payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        mode = payload.get('mode')
        if mode not in ALLOWED:
            self.respond(400, {'message': 'Unknown mode'})
            return
        MODES[self.server.server_port] = mode
        self.respond(200, {'mode': mode})

    do_PUT = do_POST
    do_DELETE = do_POST

    def do_GET(self):
        mode = MODES[self.server.server_port]
        path = self.path.split('?')[0]
        if mode == 'offline' or (mode == 'handshake-error' and path == '/v1/handshake'):
            self.respond(503, {'code': 'visual_network_failure', 'message': '验收模拟：服务连接中断，请检查连接后重试。'})
            return
        if mode == 'loading' and path not in ('/v1/health', '/v1/handshake'):
            time.sleep(25)
        if mode == 'handshake-delay' and path == '/v1/handshake':
            time.sleep(8)
        if mode == 'empty' and path == '/v1/workouts':
            self.respond(200, {'items': [], 'total': 0, 'limit': 30, 'offset': 0})
            return
        try:
            with urllib.request.urlopen(BACKEND + self.path, timeout=60) as response:
                payload = json.load(response)
            if mode == 'lock-preview' and path == '/v1/mobile/today':
                # Only enable the presentation of a normally stale recommendation.
                # No health values are invented; confirming cannot write through this proxy.
                payload['verdict']['stale'] = False
                payload['lock']['present'] = False
            self.respond(200, payload)
        except urllib.error.HTTPError as error:
            self.respond(error.code, {'code': 'upstream_error', 'message': str(error)})
        except Exception as error:
            self.respond(503, {'code': 'upstream_unavailable', 'message': str(error)})

if __name__ == '__main__':
    for port in MODES:
        server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Event().wait()
