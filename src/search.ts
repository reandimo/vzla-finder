/**
 * Búsqueda unificada. Lo que ve la familia: busca una vez, recibe el estado
 * consolidado de todos los silos, con links de vuelta a cada fuente original
 * (ahí están los datos de contacto — no los re-hosteamos).
 */
import { Store } from './db.ts';
import { consolidate } from './reconcile.ts';
import { normalizeCedula, normalizeName, nameSimilarity } from './normalize.ts';
import type { ConsolidatedPerson } from './types.ts';

/** Resultado con la marca (no destructiva) de "posible duplicado". */
export interface SearchHit extends ConsolidatedPerson {
  /** Id de grupo de posibles duplicados (mismo número = posible misma persona). null si es único. */
  dupGroup: number | null;
  /** Cuántos resultados hay en su grupo (1 si es único). */
  dupCount: number;
}

export function searchByCedula(
  store: Store,
  cedula: string,
): ConsolidatedPerson | null {
  const norm = normalizeCedula(cedula);
  if (!norm) return null;
  const person = store.findPersonByCedula(norm);
  return person ? consolidate(store, person) : null;
}

export interface NameSearchResult {
  /** Cuántas personas matchearon de verdad (tras el filtro de similitud). */
  total: number;
  /** Las primeras `limit`, ordenadas por parecido, consolidadas y marcadas. */
  results: SearchHit[];
}

export function searchByName(
  store: Store,
  query: string,
  limit = 200,
): NameSearchResult {
  const norm = normalizeName(query);
  const rough = store.searchByNameTokens(norm.split(' '));
  const ranked = rough
    .map((p) => ({ p, sim: nameSimilarity(query, p.fullName) }))
    .filter(({ sim }) => sim >= 0.3)
    .sort((a, b) => b.sim - a.sim);
  const results = ranked.slice(0, limit).map(({ p }) => consolidate(store, p));
  return { total: ranked.length, results: tagDuplicates(results) };
}

/** Tokens significativos del nombre normalizado (descarta ruido corto: "de", "la"). */
function nameTokens(p: ConsolidatedPerson): Set<string> {
  return new Set((p.nameNormalized || normalizeName(p.fullName)).split(' ').filter((t) => t.length >= 3));
}

/**
 * Marca, SIN fusionar, los resultados que probablemente son la misma persona.
 *
 * Criterio conservador (preferimos NO agrupar antes que agrupar de más):
 *  - comparten ≥2 tokens de nombre (ej. "oriana" + "ustariz"), y
 *  - NO tienen ambas una cédula DISTINTA (si las dos traen cédula y difieren, la
 *    cédula manda: son personas distintas, no se sugieren como duplicado).
 *
 * Es una PISTA visual para la familia; el dato nunca se fusiona sin cédula.
 */
export function tagDuplicates(results: ConsolidatedPerson[]): SearchHit[] {
  const n = results.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };

  const tokens = results.map(nameTokens);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ci = results[i].cedula, cj = results[j].cedula;
      if (ci && cj && ci !== cj) continue; // dos cédulas distintas = personas distintas
      let shared = 0;
      for (const t of tokens[i]) if (tokens[j].has(t)) shared++;
      if (shared >= 2) union(i, j);
    }
  }

  // Tamaño por grupo y numeración estable (1,2,3…) según orden de aparición.
  const size = new Map<number, number>();
  for (let i = 0; i < n; i++) size.set(find(i), (size.get(find(i)) ?? 0) + 1);
  const groupNum = new Map<number, number>();
  let next = 1;
  return results.map((p, i) => {
    const root = find(i);
    const count = size.get(root) ?? 1;
    let dupGroup: number | null = null;
    if (count > 1) {
      if (!groupNum.has(root)) groupNum.set(root, next++);
      dupGroup = groupNum.get(root)!;
    }
    return { ...p, dupGroup, dupCount: count };
  });
}
