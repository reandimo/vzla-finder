/**
 * Ingesta de registros ya parseados: normaliza → dedup → guarda persona,
 * procedencia y nota de estado. No sabe nada de red ni de caché (de eso se
 * encarga el runner). Así se testea y reusa fácil.
 */
import { Store } from './db.ts';
import { resolvePerson } from './dedup.ts';
import { normalizeCedula } from './normalize.ts';
import type { RawRecord, SourceAdapter } from './types.ts';

export interface IngestStats {
  fetched: number;
  newPersons: number;
  mergedByCedula: number;
  errors: number;
}

export function ingestRecords(
  store: Store,
  adapter: SourceAdapter,
  records: RawRecord[],
): IngestStats {
  const now = new Date().toISOString();
  const stat: IngestStats = { fetched: 0, newPersons: 0, mergedByCedula: 0, errors: 0 };

  for (const raw of records) {
    try {
      if (!raw.fullName?.trim()) continue;
      stat.fetched++;

      const { personId, created, matchedBy } = resolvePerson(store, raw, adapter.domain);
      if (created) stat.newPersons++;
      else if (matchedBy === 'cedula') stat.mergedByCedula++;

      const existingLink = store.getLinkBySource(adapter.domain, raw.sourceId);
      store.upsertSourceLink({
        personId,
        sourceDomain: adapter.domain,
        sourceId: raw.sourceId,
        sourceUrl: raw.sourceUrl ?? null,
        rawName: raw.fullName,
        rawCedula: normalizeCedula(raw.cedula),
        firstSeen: existingLink?.firstSeen ?? now,
        lastSeen: now,
      });

      const status = raw.status ?? 'sin_contacto';
      // UNA nota por (fuente, registro): el status es un dato que se PISA en cada
      // corrida, no parte de la clave. Si incluyéramos el status en el note_id, un
      // cambio de estado (p.ej. localizado→vuelto a buscar) dejaría la nota vieja
      // conviviendo con la nueva y reconcile seguiría viéndolo "localizado" para
      // siempre (falsa esperanza). La clave estable es dominio:sourceId.
      store.addNote({
        noteId: `${adapter.domain}:${raw.sourceId}`,
        personId,
        sourceDomain: adapter.domain,
        status,
        noteText: null,
        sourceTimestamp: raw.lastSeenAt ?? null,
        ingestedAt: now,
      });
    } catch (err) {
      console.error(`[${adapter.domain}] registro falló:`, (err as Error).message);
      stat.errors++;
    }
  }

  return stat;
}
