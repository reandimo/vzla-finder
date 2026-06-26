/**
 * Servidor HTTP mínimo (node:http, sin dependencias) que expone el buscador
 * unificado y sirve el frontend estático.
 *
 *   GET /api/search?cedula=V-12.345.678
 *   GET /api/search?name=jose%20perez
 *
 * Las respuestas pasan por el QueryCache (TTL corto) para absorber picos.
 * Pensado para correr detrás de Cloudflare (edge cache = primera línea).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './db.ts';
import { searchByCedula, searchByName } from './search.ts';
import { QueryCache } from './cache.ts';
import type { ConsolidatedPerson } from './types.ts';

const DB_PATH = process.env.VZLA_DB ?? 'data.db';
const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

const store = new Store(DB_PATH);
const cache = new QueryCache<ConsolidatedPerson[]>(30_000);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (url.pathname === '/api/search') {
      return handleSearch(url, res);
    }
    return serveStatic(url.pathname, res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal', detail: (err as Error).message }));
  }
});

function handleSearch(url: URL, res: any) {
  const cedula = url.searchParams.get('cedula')?.trim();
  const name = url.searchParams.get('name')?.trim();

  let results: ConsolidatedPerson[];
  if (cedula) {
    const key = `c:${cedula.toLowerCase()}`;
    results = cache.wrap(key, () => {
      const r = searchByCedula(store, cedula);
      return r ? [r] : [];
    });
  } else if (name && name.length >= 2) {
    const key = `n:${name.toLowerCase()}`;
    results = cache.wrap(key, () => searchByName(store, name));
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Indicá ?cedula= o ?name= (mín. 2 caracteres).' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ count: results.length, results }));
}

async function serveStatic(pathname: string, res: any) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // Evitar path traversal.
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const body = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
  }
}

server.listen(PORT, () => {
  console.log(`vzla-finder buscador en http://localhost:${PORT}`);
});
