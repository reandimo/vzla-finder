/**
 * Dedup en capas:
 *
 *   Capa 1 — CÉDULA: match exacto. Misma cédula = misma persona. Merge seguro.
 *   Capa 2 — FUZZY (sin cédula): nombre + edad ± margen + mismo estado.
 *            NO fusiona. Crea una "posible coincidencia" para revisión humana.
 *
 * Regla de oro: un falso "es la misma persona / está a salvo" es más cruel que
 * no tener el dato. Ante la duda, sugerir; nunca decidir solo.
 */
import { randomUUID } from 'node:crypto';
import type { RawRecord, PersonRecord } from './types.ts';
import { Store } from './db.ts';
import { normalizeCedula, normalizeName, nameSimilarity } from './normalize.ts';

const NAME_THRESHOLD = 0.86; // umbral conservador para sugerir coincidencia
const AGE_TOLERANCE = 2;

export interface ResolveResult {
  personId: string;
  created: boolean;
  matchedBy: 'cedula' | 'new';
}

/**
 * Resuelve un RawRecord a una persona canónica.
 * - Con cédula: busca/crea por cédula (merge determinístico).
 * - Sin cédula: crea persona nueva y lanza sugerencias fuzzy contra candidatos.
 */
export function resolvePerson(store: Store, raw: RawRecord): ResolveResult {
  const now = new Date().toISOString();
  const cedula = normalizeCedula(raw.cedula);

  if (cedula) {
    const existing = store.findPersonByCedula(cedula);
    if (existing) {
      // Enriquecer huecos sin pisar datos ya presentes.
      const merged: PersonRecord = {
        ...existing,
        fullName: existing.fullName || raw.fullName,
        nameNormalized: existing.nameNormalized || normalizeName(raw.fullName),
        age: existing.age ?? raw.age ?? null,
        gender: existing.gender ?? raw.gender ?? null,
        lastSeenState: existing.lastSeenState ?? raw.state ?? null,
        lastSeenCity: existing.lastSeenCity ?? raw.city ?? null,
        lastSeenRef: existing.lastSeenRef ?? raw.reference ?? null,
        photoUrl: existing.photoUrl ?? raw.photoUrl ?? null,
        updatedAt: now,
      };
      store.upsertPerson(merged);
      return { personId: existing.personId, created: false, matchedBy: 'cedula' };
    }
    const person = newPerson(raw, cedula, now);
    store.upsertPerson(person);
    return { personId: person.personId, created: true, matchedBy: 'cedula' };
  }

  // Sin cédula: crear persona nueva y sugerir coincidencias (sin fusionar).
  const person = newPerson(raw, null, now);
  store.upsertPerson(person);
  suggestFuzzyMatches(store, person, raw, now);
  return { personId: person.personId, created: true, matchedBy: 'new' };
}

function suggestFuzzyMatches(
  store: Store,
  person: PersonRecord,
  raw: RawRecord,
  now: string,
) {
  const candidates = store.personsWithoutCedula(raw.state ?? null);
  for (const cand of candidates) {
    if (cand.personId === person.personId) continue;
    const sim = nameSimilarity(person.fullName, cand.fullName);
    if (sim < NAME_THRESHOLD) continue;
    if (
      person.age != null &&
      cand.age != null &&
      Math.abs(person.age - cand.age) > AGE_TOLERANCE
    )
      continue;
    store.addSuggestion({
      personIdA: person.personId,
      personIdB: cand.personId,
      score: Number(sim.toFixed(3)),
      reason: `nombre~${sim.toFixed(2)}; estado=${person.lastSeenState ?? '?'}; edad±${AGE_TOLERANCE}`,
      createdAt: now,
    });
  }
}

function newPerson(raw: RawRecord, cedula: string | null, now: string): PersonRecord {
  return {
    personId: randomUUID(),
    cedula,
    fullName: raw.fullName,
    nameNormalized: normalizeName(raw.fullName),
    age: raw.age ?? null,
    gender: raw.gender ?? null,
    lastSeenState: raw.state ?? null,
    lastSeenCity: raw.city ?? null,
    lastSeenRef: raw.reference ?? null,
    photoUrl: raw.photoUrl ?? null,
    createdAt: now,
    updatedAt: now,
  };
}
