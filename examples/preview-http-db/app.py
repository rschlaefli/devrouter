import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

import psycopg


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self.send_error(404)
            return
        try:
            with psycopg.connect(os.environ["DATABASE_URL"], connect_timeout=3) as connection:
                row = connection.execute("SELECT 1").fetchone()
            healthy = row == (1,)
        except Exception:
            healthy = False
        body = json.dumps({"ready": healthy, "fixture": "http-postgres"}).encode()
        self.send_response(200 if healthy else 503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
