// Tiny static file server for the built site (dist/). No dependencies.
// Binds to 127.0.0.1 only: the tunnel (ngrok/cloudflared) connects locally,
// so nothing on your Wi-Fi or mobile network can reach it directly.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const FLAG = path.join(ROOT, 'maintenance.flag'); // exists => maintenance mode
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const started = Date.now();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://cloudflareinsights.com; form-action 'self' https:; frame-ancestors 'none'",
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY, ...headers });
  res.end(body);
}

function resolveFile(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  if (p.includes('\0')) return null;
  const full = path.normalize(path.join(DIST, p));
  if (full !== DIST && !full.startsWith(DIST + path.sep)) return null; // block ../ traversal
  try {
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      const idx = path.join(full, 'index.html');
      return fs.existsSync(idx) ? idx : null;
    }
    return full;
  } catch {
    return null;
  }
}

// Text assets are compressed once per file version and kept in memory, so the phone's CPU
// is spent on compression only the first time a file is requested.
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.xml', '.txt', '.svg', '.webmanifest']);
const zcache = new Map();
const ZCACHE_MAX = 300;

function pickEncoding(req) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

function compressed(file, st, enc) {
  const key = `${file}|${enc}|${st.size}|${st.mtimeMs}`;
  let buf = zcache.get(key);
  if (!buf) {
    const raw = fs.readFileSync(file);
    buf = enc === 'br'
      ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
      : zlib.gzipSync(raw, { level: 6 });
    if (zcache.size >= ZCACHE_MAX) zcache.delete(zcache.keys().next().value);
    zcache.set(key, buf);
  }
  return buf;
}

function serveFile(req, res, file, status = 200) {
  const ext = path.extname(file).toLowerCase();
  const st = fs.statSync(file);
  const immutable = file.includes(`${path.sep}_astro${path.sep}`);
  const enc = COMPRESSIBLE.has(ext) && st.size > 1024 ? pickEncoding(req) : null;
  const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}${enc ? '-' + enc : ''}"`;
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : ext === '.html' ? 'public, max-age=300' : 'public, max-age=3600',
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    Vary: 'Accept-Encoding',
  };
  // Conditional request: the browser already has this exact version.
  if (status === 200 && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...SECURITY, ETag: etag, 'Cache-Control': headers['Cache-Control'], Vary: headers.Vary });
    return res.end();
  }
  if (enc) {
    const body = compressed(file, st, enc);
    res.writeHead(status, { ...SECURITY, ...headers, 'Content-Encoding': enc, 'Content-Length': body.length });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  res.writeHead(status, { ...SECURITY, ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

const server = http.createServer((req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    const url = new URL(req.url, 'http://localhost');

    // Health endpoint: used by `hub status` and external monitors. Never cached.
    if (url.pathname === '/healthz') {
      const maintenance = fs.existsSync(FLAG);
      return send(res, 200, JSON.stringify({ ok: true, maintenance, uptimeSeconds: Math.round((Date.now() - started) / 1000) }), {
        'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      });
    }

    // Maintenance mode: every page returns 503 with the offline page.
    if (fs.existsSync(FLAG)) {
      const page = path.join(DIST, 'maintenance', 'index.html');
      if (fs.existsSync(page)) {
        const body = fs.readFileSync(page);
        return send(res, 503, req.method === 'HEAD' ? undefined : body, { 'Content-Type': TYPES['.html'], 'Retry-After': '3600', 'Cache-Control': 'no-store' });
      }
      return send(res, 503, 'Offline for maintenance. Back soon.', { 'Content-Type': 'text/plain', 'Retry-After': '3600' });
    }

    const file = resolveFile(url.pathname);
    if (file) {
      // Redirect /about -> /about/ so relative behavior stays consistent.
      if (!url.pathname.endsWith('/') && file.endsWith('index.html') && !path.extname(url.pathname)) {
        return send(res, 301, '', { Location: url.pathname + '/' + url.search });
      }
      return serveFile(req, res, file);
    }
    const nf = path.join(DIST, '404.html');
    return fs.existsSync(nf) ? serveFile(req, res, nf, 404) : send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  } catch (err) {
    log('ERROR', err);
    send(res, 500, 'Server error', { 'Content-Type': 'text/plain' });
  }
});

server.listen(PORT, HOST, () => log(`Serving ${DIST} on http://${HOST}:${PORT}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('Shutting down'); server.close(() => process.exit(0)); });
