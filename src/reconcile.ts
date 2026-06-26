/**
 * Reconciliación de estado: la "buena noticia gana".
 *
 * Si CUALQUIER fuente reporta a la persona como "localizado", el estado
 * consolidado es "localizado", y registramos quién y cuándo lo reportó.
 * Esto es lo que evita seguir mostrando como desaparecido a alguien que ya
 * apareció en otro silo.
 */
import type { ConsolidatedPerson, PersonRecord, Status } from './types.ts';
import { Store } from './db.ts';

export function consolidate(store: Store, person: PersonRecord): ConsolidatedPerson {
  const notes = store.notesForPerson(person.personId);
  const sources = store.linksForPerson(person.personId);

  let consolidatedStatus: Status = 'sin_contacto';
  let resolvedBy: string | null = null;
  let resolvedAt: string | null = null;

  // Buscar la primera nota "localizado" (cronológica) entre todas las fuentes.
  const located = notes
    .filter((n) => n.status === 'localizado')
    .sort((a, b) => (a.ingestedAt < b.ingestedAt ? -1 : 1))[0];

  if (located) {
    consolidatedStatus = 'localizado';
    resolvedBy = located.sourceDomain;
    resolvedAt = located.sourceTimestamp ?? located.ingestedAt;
  } else if (notes.some((n) => n.status === 'sin_contacto')) {
    consolidatedStatus = 'sin_contacto';
  } else {
    consolidatedStatus = 'desconocido';
  }

  return { ...person, consolidatedStatus, resolvedBy, resolvedAt, sources, notes };
}
