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
import { adapters } from './sources/index.ts';
import { notifySuggestion } from './notify.ts';
import type { ConsolidatedPerson } from './types.ts';

const DB_PATH = process.env.VZLA_DB ?? 'data.db';
const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

// Cloudflare Turnstile (anti-abuso del form de sugerencias). OPCIONAL: si no hay
// secret configurado, no se exige verificación (el form sigue funcionando igual).
const TURNSTILE_SITEKEY = process.env.TURNSTILE_SITEKEY ?? '';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET ?? '';

// Dominio canónico (migración). Si está seteado, cualquier request con otro host
// se redirige 301 a él (apex). Inerte si no se configura. Ej: busquedaunificadavzla.com
const CANONICAL_HOST = (process.env.CANONICAL_HOST ?? '').toLowerCase();

const store = new Store(DB_PATH);
// Guarda tanto arrays (búsqueda por cédula) como { total, results } (por nombre),
// bajo prefijos de clave distintos (c: / n:). De ahí el tipo laxo.
const cache = new QueryCache<any>(30_000);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    // Redirección canónica (migración de dominio): manda 301 al host oficial.
    const reqHost = (req.headers.host ?? '').toLowerCase().split(':')[0];
    if (CANONICAL_HOST && reqHost && reqHost !== CANONICAL_HOST) {
      res.writeHead(301, { Location: `https://${CANONICAL_HOST}${req.url ?? '/'}` });
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (url.pathname === '/api/search') {
      return handleSearch(url, res);
    }
    if (url.pathname === '/api/sources' && req.method === 'GET') {
      return handleSources(res);
    }
    if (url.pathname === '/api/suggest-source' && req.method === 'POST') {
      return handleSuggestSource(req, res);
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

  let total: number;
  let results: ConsolidatedPerson[];
  if (cedula) {
    const key = `c:${cedula.toLowerCase()}`;
    results = cache.wrap(key, () => {
      const r = searchByCedula(store, cedula);
      return r ? [r] : [];
    });
    total = results.length;
  } else if (name && name.length >= 2) {
    const key = `n:${name.toLowerCase()}`;
    const r = cache.wrap(key, () => searchByName(store, name));
    results = r.results;
    total = r.total; // cuántas matchearon en total (puede ser > results.length)
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Indica ?cedula= o ?name= (mín. 2 caracteres).' }));
    return;
  }

  // `count` = cuántas se devuelven; `total` = cuántas matchearon (para avisar si hay más).
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ count: results.length, total, results }));
}

/** Lista de fuentes que el agregador consulta hoy (para mostrarlas en el landing). */
function handleSources(res: any) {
  const sources = adapters.map((a) => {
    const snap = store.getSnapshot(a.domain);
    return {
      domain: a.domain,
      url: `https://${a.domain}`,
      everyMinutes: a.config.intervalMinutes,
      lastFetched: snap?.fetchedAt ?? null,
      ok: snap ? snap.ok : null,
    };
  });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    count: sources.length,
    totalRecords: store.countPersons(),
    turnstileSiteKey: TURNSTILE_SITEKEY || null,
    sources,
  }));
}

/**
 * Verifica el token de Turnstile contra Cloudflare. Si no hay secret configurado,
 * devuelve true (verificación deshabilitada). Falla cerrado ante errores.
 */
async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  if (!TURNSTILE_SECRET) return true; // no configurado → no se exige
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as { success?: boolean };
    return !!data.success;
  } catch {
    return false;
  }
}

/** Recibe una sugerencia de nueva fuente desde el popup del landing. */
async function handleSuggestSource(req: any, res: any) {
  let body: any;
  try {
    body = await readJson(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'JSON inválido.' }));
    return;
  }

  const url = String(body?.url ?? '').trim();
  const name = String(body?.name ?? '').trim();
  const note = String(body?.note ?? '').trim();

  // Validación mínima: tiene que parecer un enlace.
  if (!/^https?:\/\/\S+\.\S+/i.test(url) || url.length > 2000) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Indica un enlace válido (http/https) de la plataforma.' }));
    return;
  }

  // Anti-abuso: verificación Turnstile (si está configurada).
  const ip = String(req.headers['cf-connecting-ip'] ?? req.socket?.remoteAddress ?? '');
  const human = await verifyTurnstile(String(body?.turnstileToken ?? ''), ip);
  if (!human) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No pudimos verificar que no eres un bot. Recarga la página e inténtalo de nuevo.' }));
    return;
  }

  const suggestion = {
    name: name.slice(0, 200) || null,
    url: url.slice(0, 2000),
    note: note.slice(0, 1000) || null,
    createdAt: new Date().toISOString(),
  };
  store.addSourceSuggestion(suggestion);
  notifySuggestion(suggestion); // aviso por email (fire-and-forget, no bloquea)

  res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true }));
}

/** Lee el cuerpo de un request como JSON, con tope de tamaño para evitar abusos. */
function readJson(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk;
      if (raw.length > 16_384) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
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
