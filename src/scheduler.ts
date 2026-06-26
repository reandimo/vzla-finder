/**
 * Scheduler: corre cada fuente en SU propio intervalo (default 15 min), con:
 *   - Jitter inicial: las fuentes no arrancan todas en el mismo segundo.
 *   - Backoff exponencial ante errores (hasta un techo), para no machacar
 *     un sitio que está caído.
 *   - Aislamiento: cada fuente vive en su propio loop; si una falla, el resto
 *     sigue.
 *
 * Uso:  npm run watch
 * En producción puede correr como servicio (systemd / pm2) o, si preferís,
 * disparar runAll() desde un cron del sistema cada 15 min en vez de este loop.
 */
import { Store } from './db.ts';
import { runSource } from './runner.ts';
import { adapters } from './sources/index.ts';
import type { SourceAdapter } from './types.ts';

const MAX_BACKOFF_MS = 30 * 60_000; // techo: 30 min

function jitter(maxMs: number) {
  return Math.floor(Math.random() * maxMs);
}

async function loopSource(store: Store, adapter: SourceAdapter) {
  const baseInterval = adapter.config.intervalMinutes * 60_000;
  let backoff = 0;

  // Arranque escalonado para no alinear todas las fuentes.
  await sleep(jitter(adapter.config.jitterMs));

  for (;;) {
    const t0 = Date.now();
    let failed = false;
    try {
      const stats = await runSource(store, adapter);
      if (stats.outcome === 'error') failed = true;
      else {
        backoff = 0;
        log(adapter.domain, stats.outcome, stats.fetched, stats.newPersons, stats.mergedByCedula);
      }
    } catch (err) {
      failed = true;
      console.error(`[${adapter.domain}] loop error:`, (err as Error).message);
    }

    if (failed) {
      backoff = backoff === 0 ? 60_000 : Math.min(backoff * 2, MAX_BACKOFF_MS);
      console.warn(`[${adapter.domain}] backoff ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
      continue;
    }

    // Intervalo normal + jitter, descontando lo que tardó la corrida.
    const elapsed = Date.now() - t0;
    const wait = Math.max(0, baseInterval - elapsed) + jitter(adapter.config.jitterMs);
    await sleep(wait);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(domain: string, outcome: string, fetched: number, nw: number, merged: number) {
  const ts = new Date().toISOString();
  console.log(`${ts}  ${domain.padEnd(36)} ${outcome.padEnd(15)} fetched=${fetched} new=${nw} merged=${merged}`);
}

export function startScheduler(dbPath = 'data.db') {
  const store = new Store(dbPath);
  console.log(`Scheduler arrancado. ${adapters.length} fuente(s), intervalos:`);
  for (const a of adapters) {
    console.log(`  • ${a.domain}: cada ${a.config.intervalMinutes} min`);
    void loopSource(store, a); // cada fuente, su propio loop independiente
  }
}
