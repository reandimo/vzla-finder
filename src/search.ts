/**
 * Búsqueda unificada. Lo que ve la familia: busca una vez, recibe el estado
 * consolidado de todos los silos, con links de vuelta a cada fuente original
 * (ahí están los datos de contacto — no los re-hosteamos).
 */
import { Store } from './db.ts';
import { consolidate } from './reconcile.ts';
import { normalizeCedula, normalizeName, nameSimilarity } from './normalize.ts';
import type { ConsolidatedPerson } from './types.ts';

export function searchByCedula(
  store: Store,
  cedula: string,
): ConsolidatedPerson | null {
  const norm = normalizeCedula(cedula);
  if (!norm) return null;
  const person = store.findPersonByCedula(norm);
  return person ? consolidate(store, person) : null;
}

export function searchByName(
  store: Store,
  query: string,
  limit = 60,
): ConsolidatedPerson[] {
  const norm = normalizeName(query);
  const rough = store.searchByNameTokens(norm.split(' '));
  return rough
    .map((p) => ({ p, sim: nameSimilarity(query, p.fullName) }))
    .filter(({ sim }) => sim >= 0.3)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit)
    .map(({ p }) => consolidate(store, p));
}
