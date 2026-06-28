/**
 * Normalización y similitud. El corazón del dedup confiable.
 *
 * La cédula es el ID nacional único de Venezuela: donde existe, el match
 * entre silos es exacto. El fuzzy por nombre queda SOLO como respaldo para
 * registros sin cédula, y nunca decide un merge por sí solo.
 */

/**
 * Normaliza una cédula venezolana a forma canónica comparable.
 *   "V-12.345.678"  -> "V12345678"
 *   "v 12345678"    -> "V12345678"
 *   "12.345.678"    -> "V12345678"  (sin prefijo asumimos V)
 *   "E-84.111.222"  -> "E84111222"  (extranjero)
 * Devuelve null si no hay dígitos suficientes para ser una cédula plausible.
 */
export function normalizeCedula(input?: string | null): string | null {
  if (!input) return null;
  const cleaned = input.toUpperCase().replace(/[^VEJG0-9]/g, '');
  const m = cleaned.match(/^([VEJG]?)0*([0-9]{5,9})$/);
  if (!m) return null;
  const prefix = m[1] || 'V';
  return prefix + m[2];
}

/** Quita acentos, baja a minúsculas, colapsa espacios y puntuación. */
export function normalizeName(input?: string | null): string {
  if (!input) return '';
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // diacríticos
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Distancia de Levenshtein clásica. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Ratio de Levenshtein 0..1 (1 = idéntico). */
function levRatio(a: string, b: string): number {
  if (!a && !b) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

/**
 * Similitud de nombres tolerante a orden de palabras y nombres parciales.
 * Combina solapamiento de tokens (Jaccard) con ratio de edición sobre el
 * nombre ordenado por tokens. Bueno para "José Pérez" vs "Perez Jose Gabriel".
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  const jaccard = union === 0 ? 0 : inter / union;

  const sortedA = [...na.split(' ')].sort().join(' ');
  const sortedB = [...nb.split(' ')].sort().join(' ');
  const lev = levRatio(sortedA, sortedB);

  return 0.5 * jaccard + 0.5 * lev;
}
