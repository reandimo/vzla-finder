/**
 * Backfill (una sola vez) del histórico completo de venezuelatebusca.com.
 *
 * El adaptador normal solo trae las 8 páginas más nuevas por corrida; esto pagina
 * en profundidad TODO el listado (~30k reportes, ~1.5k páginas) y lo ingiere. Es
 * la fuente CON cédula, así que mejora el dedup de todo el conjunto.
 *
 * Cortés: una request cada DELAY_MS (default 1.2s) con UA identificable. Re-correr
 * es idempotente (ingest hace upsert por sourceId).
 *
 *   VZLA_DB=/ruta/data.db node --experimental-sqlite --import tsx \
 *     scripts/backfill-venezuelatebusca.ts
 *
 * Env: MAX_PAGES (default 2000), DELAY_MS (default 1200), START_PAGE (default 1).
 */
import { Store } from '../src/db.ts';
import { ingestRecords } from '../src/ingest.ts';
import { VenezuelaTeBuscaAdapter } from '../src/sources/venezuelatebusca.ts';

const BASE = 'https://venezuelatebusca.com';
const UA = 'vzla-finder/1.0 (agregador solidario de desaparecidos; backfill; +https://busquedaunificadavzla.com)';
const DB = process.env.VZLA_DB ?? 'data.db';
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 2000);
const DELAY_MS = Number(process.env.DELAY_MS ?? 1200);
const START_PAGE = Number(process.env.START_PAGE ?? 1);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const store = new Store(DB);
const adapter = new VenezuelaTeBuscaAdapter();

let totalFetched = 0;
let totalNew = 0;
let totalMerged = 0;
let emptyStreak = 0;

console.log(`[backfill] inicio · db=${DB} · páginas ${START_PAGE}..${MAX_PAGES} · delay=${DELAY_MS}ms`);

for (let p = START_PAGE; p <= MAX_PAGES; p++) {
  let text: string;
  try {
    const res = await fetch(`${BASE}/_root.data?page=${p}`, {
      headers: { 'User-Agent': UA, Accept: 'text/x-script, application/json, */*' },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      console.error(`[backfill] page ${p}: HTTP ${res.status}`);
      if (p === START_PAGE) process.exit(1);
      await sleep(DELAY_MS * 2);
      continue;
    }
    text = await res.text();
  } catch (err) {
    console.error(`[backfill] page ${p}: ${(err as Error).message} — reintento tras pausa`);
    await sleep(DELAY_MS * 3);
    continue;
  }

  let records;
  try {
    records = adapter.parse(JSON.stringify([text]));
  } catch (err) {
    console.error(`[backfill] page ${p}: parse falló: ${(err as Error).message}`);
    records = [];
  }

  if (records.length === 0) {
    emptyStreak++;
    if (emptyStreak >= 3) {
      console.log(`[backfill] fin: 3 páginas vacías seguidas (última p=${p}).`);
      break;
    }
  } else {
    emptyStreak = 0;
    const stats = ingestRecords(store, adapter, records);
    totalFetched += stats.fetched;
    totalNew += stats.newPersons;
    totalMerged += stats.mergedByCedula;
  }

  if (p % 25 === 0) {
    console.log(`[backfill] p=${p} · fetched=${totalFetched} new=${totalNew} merged=${totalMerged}`);
  }
  await sleep(DELAY_MS);
}

console.log(`[backfill] LISTO · fetched=${totalFetched} new=${totalNew} mergedByCedula=${totalMerged} · personas en DB=${store.countPersons()}`);
