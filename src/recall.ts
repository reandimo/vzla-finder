/**
 * Recall de candidatos para el desempate por IA (Stage 1 del flujo de ai-dedup).
 *
 * Propone clusters de personas que PODRÍAN ser la misma — NO fusiona nada. La
 * precisión la pone después la IA (ver scripts/ai-dedup.ts); acá priorizamos
 * recall (typos, orden de apellidos) pero acotado para no encadenar a personas
 * que solo comparten UN apellido común.
 *
 * Solo aplica a personas SIN cédula: con cédula el merge ya es exacto.
 *
 * Criterio de candidatura (igual que el tagDuplicates en vivo, + tolerancia a
 * typos): dos personas son candidatas si comparten ≥2 tokens de nombre, donde
 * "compartir" admite igualdad O cercanía de edición (typo). Pedir DOS tokens
 * evita los blobs por apellido común ("todos los González").
 *
 * Coste: comparar todas contra todas (~N²) es inviable con decenas de miles.
 * Hacemos *blocking* por token exacto y por prefijo de 4 (para typos al final);
 * solo evaluamos pares dentro del mismo bloque, y los bloques gigantes (un
 * nombre muy común) no blocan por sí solos.
 */
import { normalizeName, levenshtein } from './normalize.ts';
import type { PersonRecord } from './types.ts';

export interface DupCluster {
  members: PersonRecord[];
}

/** Un token/prefijo presente en más de tantas personas no bloca por sí solo. */
export const MAX_BLOCK = 600;

/** Nombres placeholder que NO representan a una persona nombrada (no se agrupan). */
const JUNK_NAME =
  /\b(persona|personas)\b.*\bidentificar\b|por identificar|sin nombre|desconocid|no identificad|whatsapp|\bimage\b|\bimg\b|\bnn\b/;

function isPlausibleName(p: PersonRecord): boolean {
  const n = p.nameNormalized || normalizeName(p.fullName);
  if (JUNK_NAME.test(n)) return false;
  // Al menos dos tokens alfabéticos de largo razonable (nombre + algo más).
  return n.split(' ').filter((t) => t.length >= 3 && /[a-z]/.test(t)).length >= 2;
}

/** Tokens significativos del nombre normalizado (descarta ruido corto: "de", "la"). */
function tokensOf(p: PersonRecord): string[] {
  return (p.nameNormalized || normalizeName(p.fullName))
    .split(' ')
    .filter((t) => t.length >= 3);
}

/** Claves de blocking de un token: él mismo + su prefijo de 4 (para typos al final). */
function blockKeys(token: string): string[] {
  return token.length >= 5 ? [token, '#' + token.slice(0, 4)] : [token];
}

/** ¿Dos tokens son "el mismo" tolerando un typo? Igualdad, o edición chica en tokens largos. */
function tokensClose(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false;       // tokens cortos: solo exactos
  if (Math.abs(a.length - b.length) > 2) return false;
  const max = Math.max(a.length, b.length);
  return levenshtein(a, b) <= (max >= 7 ? 2 : 1);
}

/** Cuántos tokens de A tienen un token "cercano" en B (cada uno de B se usa una vez). */
function sharedTokenCount(ta: string[], tb: string[]): number {
  const used = new Array(tb.length).fill(false);
  let shared = 0;
  for (const a of ta) {
    for (let j = 0; j < tb.length; j++) {
      if (!used[j] && tokensClose(a, tb[j])) { used[j] = true; shared++; break; }
    }
  }
  return shared;
}

export function buildDupClusters(persons: PersonRecord[]): DupCluster[] {
  // Trabajamos solo sobre nombres plausibles (los placeholder no se agrupan).
  const work = persons.filter(isPlausibleName);
  const n = work.length;
  const toks = work.map(tokensOf);

  // Índice invertido: clave de bloque -> índices de persona.
  const index = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const keys = new Set<string>();
    for (const t of toks[i]) for (const k of blockKeys(t)) keys.add(k);
    for (const k of keys) {
      let arr = index.get(k);
      if (!arr) index.set(k, (arr = []));
      arr.push(i);
    }
  }

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };

  const checked = new Set<number>(); // pares ya evaluados (clave i*n+j, i<j)
  for (let i = 0; i < n; i++) {
    const cand = new Set<number>();
    const keys = new Set<string>();
    for (const t of toks[i]) for (const k of blockKeys(t)) keys.add(k);
    for (const k of keys) {
      const arr = index.get(k)!;
      if (arr.length > MAX_BLOCK) continue; // bloque gigante: no discrimina solo
      for (const j of arr) if (j > i) cand.add(j);
    }
    for (const j of cand) {
      if (find(i) === find(j)) continue;
      const key = i * n + j;
      if (checked.has(key)) continue;
      checked.add(key);
      if (sharedTokenCount(toks[i], toks[j]) >= 2) union(i, j);
    }
  }

  const groups = new Map<number, PersonRecord[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(work[i]);
  }
  return [...groups.values()].filter((m) => m.length >= 2).map((members) => ({ members }));
}
