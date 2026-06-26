/**
 * Flujos HTTP del servidor (API + estático), de extremo a extremo.
 *   npm run test:server
 *
 * Siembra una DB temporal, levanta el server real y le pega por HTTP.
 */
import { Store } from '../src/db.ts';
import { resolvePerson } from '../src/dedup.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? '✅' : '❌'} ${n}`); c ? pass++ : fail++; };

const dbPath = join(tmpdir(), `vzla-test-${Date.now()}.db`);
const PORT = 38997;
const base = `http://127.0.0.1:${PORT}`;

// --- sembrar una persona conocida ---
const seed = new Store(dbPath);
const { personId } = resolvePerson(seed, { sourceId: '1', fullName: 'José Pérez', cedula: 'V-12.345.678', age: 34 });
seed.upsertSourceLink({
  personId, sourceDomain: 'a.com', sourceId: '1', sourceUrl: 'https://a.com/1',
  rawName: 'José Pérez', rawCedula: 'V12345678', firstSeen: 't', lastSeen: 't',
});
seed.addNote({
  noteId: 'a.com:1', personId, sourceDomain: 'a.com', status: 'sin_contacto',
  noteText: null, sourceTimestamp: null, ingestedAt: '2026-06-26T00:00:00Z',
});

// --- levantar el server real apuntando a esa DB ---
process.env.VZLA_DB = dbPath;
process.env.PORT = String(PORT);
await import('../src/server.ts');
await new Promise((r) => setTimeout(r, 500));

const jget = async (p: string) => { const res = await fetch(base + p); return { status: res.status, body: await res.json().catch(() => null) as any }; };
const post = (p: string, b: unknown) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

// --- estático ---
const home = await fetch(base + '/');
check('GET / sirve el frontend', home.status === 200 && (await home.text()).includes('Busca a una persona'));

// --- búsqueda por cédula ---
const s = await jget('/api/search?cedula=V-12.345.678');
check('GET /api/search?cedula encuentra a la persona sembrada',
  s.status === 200 && s.body?.count === 1 && s.body.results[0].fullName === 'José Pérez');

// --- validación de búsqueda ---
check('GET /api/search sin parámetros → 400', (await jget('/api/search')).status === 400);

// --- fuentes ---
const src = await jget('/api/sources');
check('GET /api/sources lista las fuentes reales activas', src.status === 200 && src.body?.count === 2);

// --- sugerir fuente: válido / inválido / persistencia ---
check('POST /api/suggest-source válido → 201', (await post('/api/suggest-source', { url: 'https://nueva.org', name: 'Nueva' })).status === 201);
check('POST /api/suggest-source con URL inválida → 400', (await post('/api/suggest-source', { url: 'no-es-url' })).status === 400);
check('la sugerencia quedó persistida en la DB', new Store(dbPath).listSourceSuggestions().length === 1);

// --- limpieza ---
for (const ext of ['', '-wal', '-shm']) { try { rmSync(dbPath + ext); } catch { /* noop */ } }

console.log(`\n${pass} OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
