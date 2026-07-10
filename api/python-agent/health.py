from http.server import BaseHTTPRequestHandler

from _helpers import authorize, cors_path, send_error, send_json


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if cors_path(self) not in ("/api/python-agent/health", "/api/python-agent"):
            send_error(self, 404, "Not found")
            return
        if not authorize(self):
            send_error(self, 401, "Unauthorized")
            return
        send_json(
            self,
            200,
            {"ok": True, "engine": "python", "version": "1.0.0", "runtime": "vercel"},
        )

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()
