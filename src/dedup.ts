/**
 * Dedup en capas (camino CALIENTE de la ingesta — barato y determinista):
 *
 *   Capa 1 — CÉDULA: match exacto. Misma cédula = misma persona. Merge seguro.
 *   Capa 2 — FALLBACK por silo (sin cédula): reusa la persona si este mismo silo
 *            ya reportó este sourceId; si no, crea persona nueva. NUNCA fusiona
 *            entre silos sin cédula.
 *
 * El descubrimiento de "posibles coincidencias" sin cédula (fuzzy de nombre) NO
 * vive acá: se hace OFFLINE en `recall.ts` (buildDupClusters, con blocking por
 * tokens) + la capa de IA. Antes la ingesta hacía un escaneo O(nuevos × todas-las-
 * sin-cédula) con nameSimilarity por cada registro nuevo — tolerable con la base
 * chica, pero con ~57k pasó a quemar un core ~30 min por corrida; esas sugerencias
 * además no las consumía nadie. Por eso se quitó del camino caliente.
 *
 * Regla de oro: un falso "es la misma persona / está a salvo" es más cruel que
 * no tener el dato. Ante la duda, sugerir; nunca decidir solo.
 */
import { randomUUID } from 'node:crypto';
import type { RawRecord, PersonRecord } from './types.ts';
import { Store } from './db.ts';
import { normalizeCedula, normalizeName } from './normalize.ts';

export interface ResolveResult {
  personId: string;
  created: boolean;
  matchedBy: 'cedula' | 'source' | 'new';
}

/**
 * Resuelve un RawRecord a una persona canónica.
 * - Con cédula: busca/crea por cédula (merge determinístico entre silos).
 * - Sin cédula, FALLBACK por silo: si este mismo silo ya reportó este sourceId,
 *   reusa esa persona (evita duplicar en cada re-scrape). NO cruza entre silos.
 * - Sin cédula y sin antecedente: crea persona nueva. El cruce fuzzy entre silos
 *   se hace offline (recall.ts + IA), no acá. Nunca fusiona sin cédula.
 *
 * `sourceDomain` habilita el fallback por silo; omitirlo conserva el viejo
 * comportamiento (siempre crea).
 */
export function resolvePerson(
  store: Store,
  raw: RawRecord,
  sourceDomain?: string,
): ResolveResult {
  const now = new Date().toISOString();
  const cedula = normalizeCedula(raw.cedula);

  if (cedula) {
    const existing = store.findPersonByCedula(cedula);
    if (existing) {
      store.upsertPerson(enrichGaps(existing, raw, now));
      return { personId: existing.personId, created: false, matchedBy: 'cedula' };
    }
    const person = newPerson(raw, cedula, now);
    store.upsertPerson(person);
    return { personId: person.personId, created: true, matchedBy: 'cedula' };
  }

  // Fallback sin cédula: identidad estable del propio silo (re-scrapes).
  if (sourceDomain && raw.sourceId) {
    const prior = store.getLinkBySource(sourceDomain, raw.sourceId);
    if (prior) {
      const existing = store.getPerson(prior.personId);
      if (existing) {
        store.upsertPerson(enrichGaps(existing, raw, now));
        return { personId: existing.personId, created: false, matchedBy: 'source' };
      }
    }
  }

  // Sin cédula y sin antecedente: crear persona nueva. El descubrimiento de
  // posibles coincidencias (fuzzy) corre offline en recall.ts + IA, no acá.
  const person = newPerson(raw, null, now);
  store.upsertPerson(person);
  return { personId: person.personId, created: true, matchedBy: 'new' };
}

/** Rellena huecos de una persona con datos del raw, sin pisar lo ya presente. */
function enrichGaps(existing: PersonRecord, raw: RawRecord, now: string): PersonRecord {
  return {
    ...existing,
    fullName: existing.fullName || raw.fullName,
    nameNormalized: existing.nameNormalized || normalizeName(raw.fullName),
    age: existing.age ?? raw.age ?? null,
    gender: existing.gender ?? raw.gender ?? null,
    lastSeenState: existing.lastSeenState ?? raw.state ?? null,
    lastSeenCity: existing.lastSeenCity ?? raw.city ?? null,
    lastSeenRef: pickRef(existing.lastSeenRef, raw),
    photoUrl: existing.photoUrl ?? raw.photoUrl ?? null,
    updatedAt: now,
  };
}

/**
 * Elige la referencia de ubicación. Regla general: rellena el hueco, sin pisar lo ya
 * presente. EXCEPCIÓN: una referencia de una fuente que reporta `localizado` y nombra
 * un LUGAR CONCRETO (hospital, refugio, clínica…) — el "dónde fue hallado" — gana
 * sobre una referencia vaga o de mera zona ("No lo sé", "La Guaira"): ese lugar es
 * justo lo que reúne a la familia. NO pisa otro lugar concreto ya presente (evita
 * churn entre dos fuentes que ubican distinto). Medido 2026-07-01: sin esto, el
 * hospital de ~7% de los hospitalizados quedaba oculto tras una ref genérica.
 */
function pickRef(existingRef: string | null, raw: RawRecord): string | null {
  const incoming = raw.reference?.trim() || null;
  if (!incoming) return existingRef;
  if (!existingRef?.trim()) return incoming;
  if (raw.status === 'localizado' && isConcreteVenue(incoming) && !isConcreteVenue(existingRef))
    return incoming;
  return existingRef;
}

/** ¿La referencia nombra un lugar concreto de hallazgo (no una zona ni una vaguedad)? */
function isConcreteVenue(ref: string): boolean {
  return /hospital|cl[íi]nica|refugio|cruz roja|perif[ée]rico|ambulatorio|centro de salud|materno|ipasme|dispensario|m[óo]dulo|parque|llanito/i.test(ref);
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
