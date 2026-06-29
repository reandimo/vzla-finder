/**
 * Búsqueda unificada. Lo que ve la familia: busca una vez, recibe el estado
 * consolidado de todos los silos, con links de vuelta a cada fuente original
 * (ahí están los datos de contacto — no los re-hosteamos).
 */
import { Store, type AiVerdict } from './db.ts';
import { consolidate } from './reconcile.ts';
import { normalizeCedula, normalizeName, nameSimilarity } from './normalize.ts';
import type { ConsolidatedPerson } from './types.ts';

/**
 * Confianza mínima del veredicto de IA para que pese en el agrupado visual.
 * Por debajo de esto, la IA "no está segura" → manda la regla determinista.
 */
const AI_GROUP_MIN_CONFIDENCE = 0.6;

/** Búsqueda de veredicto de IA entre dos personas (en cualquier orden), o null. */
export type VerdictLookup = (personIdA: string, personIdB: string) => AiVerdict | null;

/** Resultado con la marca (no destructiva) de "posible duplicado". */
export interface SearchHit extends ConsolidatedPerson {
  /** Id de grupo de posibles duplicados (mismo número = posible misma persona). null si es único. */
  dupGroup: number | null;
  /** Cuántos resultados hay en su grupo (1 si es único). */
  dupCount: number;
  /**
   * Si la IA juzgó "misma persona" a este registro contra el representante de su
   * grupo, su confianza (0..1). null si fue agrupado por regla determinista o si
   * es el representante. Es una PISTA visual: la IA nunca fusiona el dato.
   */
  aiConfidence: number | null;
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
  // Precarga los veredictos de IA relevantes a ESTE set (no par por par) y los
  // expone como lookup para que el agrupado los use como pista de confianza.
  const verdicts = store.verdictsAmong(results.map((r) => r.personId));
  const byPair = new Map<string, AiVerdict>();
  for (const v of verdicts) byPair.set(pairKey(v.personIdA, v.personIdB), v);
  const lookup: VerdictLookup = (a, b) => byPair.get(pairKey(a, b)) ?? null;
  return { total: ranked.length, results: tagDuplicates(results, lookup) };
}

/** Clave de par order-independiente para indexar veredictos. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Tokens significativos del nombre normalizado (descarta ruido corto: "de", "la"). */
function nameTokens(p: ConsolidatedPerson): Set<string> {
  return new Set((p.nameNormalized || normalizeName(p.fullName)).split(' ').filter((t) => t.length >= 3));
}

/** "Fuerza" de una ficha para elegirla como ancla/representante del grupo. */
function strength(p: ConsolidatedPerson): number {
  let s = 0;
  if (p.cedula) s += 1000;
  if (p.consolidatedStatus === 'localizado') s += 100;
  if (p.photoUrl) s += 10;
  if (p.age != null) s += 5;
  if (p.lastSeenRef) s += 3;
  if (p.lastSeenState || p.lastSeenCity) s += 2;
  return s;
}

/** ¿`a` y `b` son candidatos a "posible duplicado"? Predicado conservador, NO fusión. */
function linkable(
  a: ConsolidatedPerson, b: ConsolidatedPerson,
  ta: Set<string>, tb: Set<string>,
  verdict: AiVerdict | null,
): boolean {
  const ca = a.cedula, cb = b.cedula;
  // Dos cédulas: solo se agrupan si son IGUALES. Cédulas "casi iguales" (typo) NO
  // se deciden acá: un typo de cédula + typo de nombre puede ser otra persona, y
  // distinguirlo es pesar varios campos (nombre/edad/zona/referencia) a la vez —
  // eso lo hace la IA con contexto, no una regla determinista que cuenta dígitos.
  if (ca && cb) return ca === cb;
  // Veredicto de IA (solo aplica a pares sin dos cédulas; a la IA nunca le pasamos
  // cédula). Con suficiente confianza, REFINA el agrupado en ambos sentidos: junta
  // typos que el nombre-contención perdería (Ustariz/Uztaris) y SEPARA homónimos
  // que el nombre uniría. Sigue siendo etiqueta visual: el dato NO se fusiona.
  if (verdict && verdict.confidence >= AI_GROUP_MIN_CONFIDENCE) {
    if (verdict.verdict === 'same') return true;
    if (verdict.verdict === 'different') return false;
  }
  // Al menos una sin cédula: el nombre más corto debe estar CONTENIDO en el más
  // largo (≥2 tokens). Así "Oriana Ustariz" ⊆ "Oriana Andrea Ustariz Dinis" sí
  // agrupan, pero "Julio César Diaz" y "Julio César Cruz" —que comparten los dos
  // nombres comunes pero cada uno tiene su propio apellido— NO se mezclan.
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared >= 2 && shared === Math.min(ta.size, tb.size);
}

/**
 * Marca, SIN fusionar, los resultados que probablemente son la misma persona.
 *
 * Agrupa por *linkage contra un representante* (no union-find transitivo): cada
 * registro se une al PRIMER líder (ancla más completa) con el que es `linkable`.
 * Esto evita los "blobs" por nombre común — donde A se pega a B, B a C, C a D y
 * termina mezclando homónimos distintos ("Cesar Pacheco" con "Eva Pacheco")—,
 * porque un registro debe parecerse al ANCLA, no a un vecino cualquiera.
 *
 * Criterios de `linkable` (conservador, es una PISTA visual; nunca fusiona):
 *  - sin cédula (al menos uno): ≥2 tokens de nombre compartidos;
 *  - dos cédulas iguales: misma persona;
 *  - dos cédulas distintas: NO se agrupan.
 *
 * Si se pasa `getVerdict`, los juicios de IA (con confianza ≥ umbral) refinan el
 * agrupado: "same" junta lo que el nombre perdería; "different" separa homónimos.
 * Es solo la etiqueta visual "posible duplicado": el dato NUNCA se fusiona.
 */
export function tagDuplicates(
  results: ConsolidatedPerson[],
  getVerdict?: VerdictLookup,
): SearchHit[] {
  const n = results.length;
  const tokens = results.map(nameTokens);
  const verdictOf = (i: number, j: number): AiVerdict | null =>
    getVerdict ? getVerdict(results[i].personId, results[j].personId) : null;

  // Líderes primero los más "fuertes" (cédula > localizado > ficha completa), para
  // que el grupo se forme alrededor de un ancla real y estable.
  const order = [...results.keys()].sort((a, b) => strength(results[b]) - strength(results[a]));
  const leaderOf = new Array<number>(n).fill(-1);
  const leaders: number[] = [];
  for (const i of order) {
    let chosen = -1;
    for (const L of leaders) {
      if (linkable(results[i], results[L], tokens[i], tokens[L], verdictOf(i, L))) { chosen = L; break; }
    }
    if (chosen === -1) { leaders.push(i); leaderOf[i] = i; }
    else leaderOf[i] = chosen;
  }

  // Tamaño por grupo y numeración estable (1,2,3…) según orden de aparición.
  const size = new Map<number, number>();
  for (let i = 0; i < n; i++) size.set(leaderOf[i], (size.get(leaderOf[i]) ?? 0) + 1);
  const groupNum = new Map<number, number>();
  let next = 1;
  return results.map((p, i) => {
    const root = leaderOf[i];
    const count = size.get(root) ?? 1;
    let dupGroup: number | null = null;
    if (count > 1) {
      if (!groupNum.has(root)) groupNum.set(root, next++);
      dupGroup = groupNum.get(root)!;
    }
    // Pista de confianza: si la IA dijo "misma persona" entre este registro y su
    // representante, la exponemos para el front. (El representante no la lleva.)
    let aiConfidence: number | null = null;
    if (root !== i) {
      const v = verdictOf(i, root);
      if (v && v.verdict === 'same' && v.confidence >= AI_GROUP_MIN_CONFIDENCE) aiConfidence = v.confidence;
    }
    return { ...p, dupGroup, dupCount: count, aiConfidence };
  });
}
