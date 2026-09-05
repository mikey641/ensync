import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const port = Number.parseInt(process.env.ENSYNC_SITE_PORT ?? '4174', 10);
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

async function resolveRequestPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const normalized = normalize(decoded).replace(/^([/\\])+/, '');
  const candidate = resolve(join(root, normalized));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;

  try {
    const stats = await lstat(candidate);
    if (stats.isDirectory()) return join(candidate, 'index.html');
    if (stats.isFile()) return candidate;
  } catch {
    if (!extname(candidate)) {
      try {
        const htmlCandidate = `${candidate}.html`;
        if ((await lstat(htmlCandidate)).isFile()) return htmlCandidate;
      } catch {}
    }
  }

  return join(root, '404.html');
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const filePath = await resolveRequestPath(url.pathname);
  if (!filePath) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }

  const isNotFound = filePath === join(root, '404.html');
  response.writeHead(isNotFound ? 404 : 200, {
    'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
    'Cache-Control': extname(filePath) === '.json' ? 'no-store' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Ensync product site: http://127.0.0.1:${port}`);
});
