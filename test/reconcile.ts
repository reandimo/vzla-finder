/**
 * Flujos de reconciliación de estado ("la buena noticia gana").
 *   npm run test:reconcile
 */
import { Store } from '../src/db.ts';
import { resolvePerson } from '../src/dedup.ts';
import { consolidate } from '../src/reconcile.ts';
import type { RawRecord, Status } from '../src/types.ts';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? '✅' : '❌'} ${n}`); c ? pass++ : fail++; };

const store = new Store(':memory:');

/** Inserta/dedup una persona y le ata una nota de estado de una fuente. */
function feed(domain: string, raw: RawRecord, status: Status, ts: string, ingestedAt: string) {
  const { personId } = resolvePerson(store, raw);
  store.upsertSourceLink({
    personId, sourceDomain: domain, sourceId: raw.sourceId, sourceUrl: null,
    rawName: raw.fullName, rawCedula: raw.cedula ?? null, firstSeen: ingestedAt, lastSeen: ingestedAt,
  });
  store.addNote({
    noteId: `${domain}:${raw.sourceId}:${status}`, personId, sourceDomain: domain,
    status, noteText: null, sourceTimestamp: ts, ingestedAt,
  });
  return personId;
}

// --- solo "sin_contacto" → consolidado sin_contacto ---
const id1 = feed('silo-a.com',
  { sourceId: '1', fullName: 'Pedro Pérez', cedula: 'V-11.111.111' },
  'sin_contacto', '2026-06-24T10:00:00Z', '2026-06-24T10:00:00Z');
check('una sola nota sin_contacto → estado sin_contacto',
  consolidate(store, store.getPerson(id1)!).consolidatedStatus === 'sin_contacto');

// --- "localizado" de CUALQUIER fuente gana ---
feed('silo-b.com',
  { sourceId: '2', fullName: 'Pedro Pérez', cedula: 'V-11.111.111' },
  'localizado', '2026-06-25T09:00:00Z', '2026-06-25T09:00:00Z');
const c1 = consolidate(store, store.getPerson(id1)!);
check('una nota localizado consolida a localizado', c1.consolidatedStatus === 'localizado');
check('registra qué fuente dio la buena noticia', c1.resolvedBy === 'silo-b.com');
check('resolvedAt usa el timestamp de la fuente', c1.resolvedAt === '2026-06-25T09:00:00Z');

// --- ante dos "localizado", gana el más temprano (por ingestedAt) ---
const id2 = feed('silo-c.com',
  { sourceId: '3', fullName: 'Luisa Mora', cedula: 'V-22.222.222' },
  'localizado', '2026-06-25T12:00:00Z', '2026-06-25T12:00:00Z');
feed('silo-a.com',
  { sourceId: '4', fullName: 'Luisa Mora', cedula: 'V-22.222.222' },
  'localizado', '2026-06-24T08:00:00Z', '2026-06-24T08:00:00Z');
check('con varios localizado, gana el primero ingerido',
  consolidate(store, store.getPerson(id2)!).resolvedBy === 'silo-a.com');

// --- persona sin notas → desconocido ---
const { personId: id3 } = resolvePerson(store,
  { sourceId: '5', fullName: 'Sin Notas', cedula: 'V-33.333.333' } as RawRecord);
check('sin notas → estado desconocido',
  consolidate(store, store.getPerson(id3)!).consolidatedStatus === 'desconocido');

console.log(`\n${pass} OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
