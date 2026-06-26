/**
 * Flujos del runner (cache de snapshot, skip si no cambió, aislamiento de fallas).
 *   npm run test:runner
 */
import { Store } from '../src/db.ts';
import { runSource } from '../src/runner.ts';
import { DesaparecidosTerremotoAdapter } from '../src/sources/desaparecidos.ts';
import type { SourceAdapter, SourceConfig } from '../src/types.ts';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? '✅' : '❌'} ${n}`); c ? pass++ : fail++; };

const cfg: SourceConfig = { intervalMinutes: 15, minDelayMs: 0, jitterMs: 0 };
const store = new Store(':memory:');

// --- 1ª corrida ingiere; 2ª (mismo contenido) hace skip --- (fuente HTML fixtures)
const first = await runSource(store, new DesaparecidosTerremotoAdapter());
check('1ª corrida: changed e ingiere los 3', first.outcome === 'changed' && first.fetched === 3);
const second = await runSource(store, new DesaparecidosTerremotoAdapter());
check('2ª corrida sin cambios: unchanged_hash, no reprocesa', second.outcome === 'unchanged_hash' && second.fetched === 0);

// --- 304 Not Modified ---
const nm: SourceAdapter = {
  domain: 'nm.com', config: cfg,
  async fetchRaw() { return { notModified: true, body: null, etag: 'x', lastModified: null }; },
  parse() { return []; },
};
check('respuesta 304 → outcome not_modified', (await runSource(store, nm)).outcome === 'not_modified');

// --- fetch que revienta: outcome error, sin tirar la corrida ---
const boom: SourceAdapter = {
  domain: 'boom.com', config: cfg,
  async fetchRaw() { throw new Error('red caída'); },
  parse() { return []; },
};
const rb = await runSource(store, boom);
check('fetch que falla → error, no lanza', rb.outcome === 'error' && rb.errors === 1);

// --- parse que revienta: outcome error ---
const badParse: SourceAdapter = {
  domain: 'badparse.com', config: cfg,
  async fetchRaw() { return { notModified: false, body: '{"x":1}', etag: null, lastModified: null }; },
  parse() { throw new Error('parse roto'); },
};
check('parse que falla → error', (await runSource(store, badParse)).outcome === 'error');

// --- aislamiento: una fuente caída no impide ingerir otra ---
const store2 = new Store(':memory:');
await runSource(store2, boom);
const good = await runSource(store2, new DesaparecidosTerremotoAdapter());
check('una fuente caída no frena a las demás', good.outcome === 'changed' && good.fetched === 3);

console.log(`\n${pass} OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
