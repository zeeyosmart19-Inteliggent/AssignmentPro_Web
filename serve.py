#!/usr/bin/env python3
# AssignmentPro local server — CREATED BY ZEEYO
# Serves this folder at http://localhost:8080 (no extra packages needed).
import http.server, socketserver, webbrowser, os, sys, threading

PORT = 8080
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a):
        pass

socketserver.TCPServer.allow_reuse_address = True
try:
    httpd = socketserver.TCPServer(('127.0.0.1', PORT), Handler)
except OSError:
    print(f'Port {PORT} is already in use. Close the other copy of this server (or the app using it) and try again.')
    sys.exit(1)

url = f'http://localhost:{PORT}/'
print('\n  AssignmentPro is running at', url)
print('  Keep this window open. Press Ctrl+C to stop.\n')
threading.Timer(0.8, lambda: webbrowser.open(url)).start()
try:
    httpd.serve_forever()
except KeyboardInterrupt:
    print('\nStopped.')
