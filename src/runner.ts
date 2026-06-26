/**
 * Runner: orquesta una corrida de scraping con caché del lado nuestro.
 *
 * Flujo por fuente:
 *   1. Lee el snapshot previo (ETag / Last-Modified / hash).
 *   2. fetchRaw con request condicional.
 *   3. Si 304 Not Modified → no parsea ni re-ingiere. Ahorra a ellos y a nosotros.
 *   4. Si llegó cuerpo: calcula hash. Si es igual al guardado → tampoco re-ingiere
 *      (cubre sitios que no mandan 304 pero devuelven lo mismo).
 *   5. Si cambió → parsea → ingiere → guarda snapshot nuevo.
 *   6. Si falla la traída → conserva el snapshot viejo (los datos ya están en la
 *      DB) y sigue con las demás fuentes. Una fuente caída no frena al resto.
 */
import { createHash } from 'node:crypto';
import { Store } from './db.ts';
import { ingestRecords } from './ingest.ts';
import { adapters } from './sources/index.ts';
import type { SourceAdapter, Snapshot } from './types.ts';

export interface RunStats {
  domain: string;
  outcome: 'changed' | 'not_modified' | 'unchanged_hash' | 'error';
  fetched: number;
  newPersons: number;
  mergedByCedula: number;
  errors: number;
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function runSource(store: Store, adapter: SourceAdapter): Promise<RunStats> {
  const base: RunStats = {
    domain: adapter.domain,
    outcome: 'error',
    fetched: 0,
    newPersons: 0,
    mergedByCedula: 0,
    errors: 0,
  };

  const prev = store.getSnapshot(adapter.domain);
  const now = new Date().toISOString();

  let raw;
  try {
    raw = await adapter.fetchRaw({
      etag: prev?.etag ?? null,
      lastModified: prev?.lastModified ?? null,
    });
  } catch (err) {
    console.error(`[${adapter.domain}] traída falló (se conserva snapshot previo):`,
      (err as Error).message);
    base.errors = 1;
    return base;
  }

  // 304: nada cambió en el servidor.
  if (raw.notModified || raw.body == null) {
    if (prev) store.saveSnapshot({ ...prev, fetchedAt: now, ok: true });
    return { ...base, outcome: 'not_modified' };
  }

  // Mismo contenido aunque no haya 304.
  const contentHash = hash(raw.body);
  if (prev && prev.contentHash === contentHash) {
    store.saveSnapshot({ ...prev, fetchedAt: now, ok: true });
    return { ...base, outcome: 'unchanged_hash' };
  }

  // Cambió: parsear e ingerir.
  let stats;
  try {
    const records = adapter.parse(raw.body);
    stats = ingestRecords(store, adapter, records);
  } catch (err) {
    console.error(`[${adapter.domain}] parseo/ingesta falló:`, (err as Error).message);
    base.errors = 1;
    return base;
  }

  const snap: Snapshot = {
    sourceDomain: adapter.domain,
    contentHash,
    etag: raw.etag,
    lastModified: raw.lastModified,
    fetchedAt: now,
    ok: true,
  };
  store.saveSnapshot(snap);

  return { ...base, outcome: 'changed', ...stats };
}

export async function runAll(store: Store): Promise<RunStats[]> {
  const out: RunStats[] = [];
  for (const adapter of adapters) {
    out.push(await runSource(store, adapter));
  }
  return out;
}
