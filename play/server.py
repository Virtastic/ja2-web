# SPDX-License-Identifier: GPL-3.0-or-later
# Part of ja2-web (adapted from openmw-wasm).
import http.server, socketserver, os, re
os.chdir(os.path.dirname(os.path.abspath(__file__)))

# Load play/.env (KEY=VALUE, # comments) WITHOUT clobbering real env vars, so the launcher
# flag can live in a git-ignored file next to this server. Env always wins over .env.
def _load_dotenv(path):
    try:
        with open(path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                os.environ.setdefault(k, v)
    except OSError:
        pass

_load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))

PORT = int(os.environ.get('PORT', '8795'))
# The bare site root (/ and /index.html) serves the data-chooser launcher by default, so
# visiting "/" lands on the chooser. Set OPENMW_LAUNCHER=0 (in env or play/.env) to disable
# and drop straight into the game instead.
LAUNCHER = os.environ.get('OPENMW_LAUNCHER', '1').strip().lower() not in ('0', 'false', 'no')

# Dev-only: proxy /api/* to a locally-running ja2-cloud backend so the launcher's same-origin
# fetch('/api/...') works in dev exactly like prod (where the edge Caddy routes /api to the
# ja2-cloud container). Set CLOUD_API=http://localhost:8081 to enable. Off = /api 404s (the
# Cloud tile just stays hidden), matching a deploy without the cloud service.
CLOUD_API = os.environ.get('CLOUD_API', '').rstrip('/')

class H(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _proxy_api(self):
        import urllib.request, urllib.error
        # Don't follow redirects: the OAuth callback returns 302 + Set-Cookie that must reach the
        # browser intact (urllib would follow it and drop the cookie).
        class _NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k): return None
        opener = urllib.request.build_opener(_NoRedirect)
        length = int(self.headers.get('Content-Length', 0) or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(CLOUD_API + self.path, data=body, method=self.command)
        for h in ('Content-Type', 'Cookie', 'Authorization', 'Accept'):
            if self.headers.get(h):
                req.add_header(h, self.headers.get(h))
        try:
            r = opener.open(req)
            status, resp_headers, data = r.status, r.getheaders(), r.read()
        except urllib.error.HTTPError as e:
            status, resp_headers, data = e.code, list(e.headers.items()), e.read()
        except Exception as e:
            self.send_error(502, f'cloud proxy: {e}'); return
        self.send_response(status)
        for k, v in resp_headers:
            if k.lower() in ('set-cookie', 'location', 'content-type'):
                self.send_header(k, v)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def do_POST(self):
        if CLOUD_API and self.path.startswith('/api/'):
            return self._proxy_api()
        self.send_error(501)

    def do_PUT(self):
        if CLOUD_API and self.path.startswith('/api/'):
            return self._proxy_api()
        self.send_error(501)

    def send_head(self):
        if CLOUD_API and self.path.startswith('/api/'):
            return self._proxy_api()
        # Launcher gate: only the bare root serves the chooser. The match is on the FULL path
        # incl. query, so anything with a query string - the launcher's own index.html?nomw /
        # index.html?src=local links, plus dev URLs like ?debug - passes straight through to
        # the game. Explicit /launcher.html and assets are likewise untouched.
        if LAUNCHER and self.path in ('/', '/index.html'):
            self.path = '/launcher.html'
        # HTTP Range support (python's SimpleHTTPRequestHandler has none) - required for the
        # ?stream lazy-BSA mode (emscripten FS.createLazyFile reads the archives in chunks).
        rng = self.headers.get('Range')
        path = self.translate_path(self.path.split('?', 1)[0])
        if rng and os.path.isfile(path):
            m = re.match(r'bytes=(\d*)-(\d*)$', rng.strip())
            if m and (m.group(1) or m.group(2)):
                size = os.path.getsize(path)
                start = int(m.group(1)) if m.group(1) else max(0, size - int(m.group(2)))
                end = int(m.group(2)) if m.group(1) and m.group(2) else size - 1
                end = min(end, size - 1)
                if start <= end:
                    f = open(path, 'rb')
                    f.seek(start)
                    self.send_response(206)
                    self.send_header('Content-Type', self.guess_type(path))
                    self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
                    self.send_header('Content-Length', str(end - start + 1))
                    self.send_header('Accept-Ranges', 'bytes')
                    self.end_headers()
                    # SimpleHTTPRequestHandler.copyfile would send to EOF; wrap to the range length
                    class _Ranged:
                        def __init__(self, fp, n): self.fp, self.n = fp, n
                        def read(self, sz=-1):
                            if self.n <= 0: return b''
                            sz = self.n if sz < 0 else min(sz, self.n)
                            d = self.fp.read(sz); self.n -= len(d); return d
                        def close(self): self.fp.close()
                    return _Ranged(f, end - start + 1)
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */%d' % os.path.getsize(path))
                self.end_headers()
                return None
        # Serve a precompressed sibling (<file>.br) when present, fresh, and accepted -
        # roughly halves the first-visit download of the .esm/.wasm/.data payloads.
        # (wasm-build/make_br.sh generates them; the mtime check falls back to the raw
        # file if a redeploy left a stale .br behind.)
        path = self.translate_path(self.path.split('?', 1)[0])
        br = path + '.br'
        if (not path.endswith('.br') and os.path.isfile(path) and os.path.isfile(br)
                and os.path.getmtime(br) >= os.path.getmtime(path)
                and 'br' in self.headers.get('Accept-Encoding', '')):
            try:
                f = open(br, 'rb')
            except OSError:
                return super().send_head()
            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Length', str(os.fstat(f.fileno()).st_size))
            self.send_header('Content-Encoding', 'br')
            self.end_headers()
            return f
        return super().send_head()

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        # The big build artifacts are immutable - let the browser cache them so
        # the ~860MB game-data package isn't re-downloaded on every reload.
        # HTML (and anything else) stays uncached so page edits show up at once.
        path = self.path.split('?', 1)[0]
        if path.endswith(('.wasm', '.data', 'ja2.js', 'ja2-gamedata.js')):
            self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
        else:
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

socketserver.TCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer(('', PORT), H).serve_forever()
