/**
 * Backfill histórico de venezuelareporta.org.
 *
 * El cron solo trae las PAGES_PER_RUN (10) páginas más nuevas por corrida; el
 * histórico completo (~1.052 págs, ~63k reportes) se trae UNA vez con esto.
 * Reusa el parse del adapter y el ingest/dedup normales, página por página
 * (poca memoria, idempotente por sourceId=UUID, resumible).
 *
 * Uso (en la VM, como el usuario vzla):
 *   VZLA_DB=/opt/vzla/data/data.db \
 *     node --experimental-sqlite --experimental-transform-types \
 *     scripts/backfill-venezuelareporta.ts
 *
 * Env opcionales:
 *   START_PAGE (1)     — desde qué página seguir (para reanudar).
 *   MAX_PAGES  (1500)  — tope de seguridad.
 *   DELAY_MS   (2000)  — cortesía entre páginas.
 *
 * Cortesía: pausá el timer horario mientras corre para no pisar la DB
 * (`sudo systemctl stop vzla-ingest.timer`), y reactivalo al terminar.
 */
import { Store } from '../src/db.ts';
import { ingestRecords } from '../src/ingest.ts';
import { VenezuelaReportaAdapter } from '../src/sources/venezuelareporta.ts';

const BASE = 'https://venezuelareporta.org';
const UA = 'vzla-finder/1.0 (agregador solidario de desaparecidos; +https://busquedaunificadavzla.com)';
const START_PAGE = Number(process.env.START_PAGE ?? 1);
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 1500);
const DELAY_MS = Number(process.env.DELAY_MS ?? 2000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const store = new Store(process.env.VZLA_DB ?? 'data.db');
const adapter = new VenezuelaReportaAdapter();

let totalRecords = 0, totalNew = 0, totalMerged = 0, emptyName = 0;
const startedAt = Date.now();
console.log(`[backfill vr] inicio · páginas ${START_PAGE}..${MAX_PAGES} · delay ${DELAY_MS}ms`);

for (let page = START_PAGE; page <= MAX_PAGES; page++) {
  let html: string;
  try {
    const res = await fetch(`${BASE}/buscar?page=${page}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8' },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) { console.error(`[backfill vr] página ${page}: HTTP ${res.status} → paro`); break; }
    html = await res.text();
  } catch (err) {
    console.error(`[backfill vr] página ${page}: ${(err as Error).message} → reintento en 5s`);
    await sleep(5000);
    page--; // reintenta la misma página
    continue;
  }

  if (!html.includes('/reporte/')) {
    console.log(`[backfill vr] página ${page}: sin reportes → fin del listado`);
    break;
  }

  const records = adapter.parse(JSON.stringify([html]));
  const stats = ingestRecords(store, adapter, records);
  totalRecords += stats.fetched;
  totalNew += stats.newPersons;
  totalMerged += stats.mergedByCedula;
  emptyName += records.length - stats.fetched;

  if (page % 25 === 0 || page === START_PAGE) {
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`[backfill vr] pág ${page} · +${records.length} (nuevos ${stats.newPersons}) · acum ${totalRecords} · ${mins} min`);
  }
  await sleep(DELAY_MS);
}

const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
console.log(`[backfill vr] LISTO · registros ${totalRecords} · personas nuevas ${totalNew} · ${mins} min · total personas en DB: ${store.countPersons()}`);
