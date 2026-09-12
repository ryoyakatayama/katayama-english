// Local development / test file server only. Not deployed and not needed in production.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
const port = Number(process.env.PORT || 4173),
  base = process.env.BASE_PATH || '/',
  root = path.resolve('dist');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};
http
  .createServer(async (req, res) => {
    try {
      // Test-only transport disconnection. This code never appears in dist/.
      if (process.env.TEST_OFFLINE_MARKER) {
        try {
          await stat(process.env.TEST_OFFLINE_MARKER);
          req.socket.destroy();
          return;
        } catch {
          /* marker absent: serve normally */
        }
      }
      const url = new URL(req.url, 'http://localhost');
      // Bare document outside the app/SW scope for a browser-persistence probe.
      if (process.env.TEST_OFFLINE_MARKER && url.pathname === '/__cache-probe') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('<!doctype html><title>Browser storage probe</title>');
        return;
      }
      if (!url.pathname.startsWith(base)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const suffix = decodeURIComponent(url.pathname.slice(base.length));
      let target = path.resolve(root, suffix || 'index.html');
      if (target !== root && !target.startsWith(root + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if ((await stat(target)).isDirectory())
        target = path.join(target, 'index.html');
      res.writeHead(200, {
        'Content-Type':
          types[path.extname(target)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(await readFile(target));
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  })
  .listen(port, '127.0.0.1', () =>
    console.log(`Preview: http://127.0.0.1:${port}${base}`),
  );
