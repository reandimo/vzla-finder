/**
 * Flujos de deduplicación (capa cédula = merge; sin cédula = sugerencia).
 *   npm run test:dedup
 */
import { Store } from '../src/db.ts';
import { resolvePerson } from '../src/dedup.ts';
import { ingestRecords } from '../src/ingest.ts';
import type { RawRecord, SourceAdapter } from '../src/types.ts';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? '✅' : '❌'} ${n}`); c ? pass++ : fail++; };

const store = new Store(':memory:');
const raw = (r: Partial<RawRecord> & { sourceId: string; fullName: string }): RawRecord => r;

// --- capa 1: misma cédula = misma persona, merge determinístico ---
const a = resolvePerson(store, raw({ sourceId: 'A', fullName: 'José Pérez', cedula: 'V-12.345.678', age: 34 }));
check('cédula nueva → persona creada', a.created && a.matchedBy === 'cedula');
const b = resolvePerson(store, raw({ sourceId: 'B', fullName: 'Jose Perez', cedula: '12345678', state: 'La Guaira' }));
check('misma cédula (otro formato) → NO crea, matchea por cédula', !b.created && b.matchedBy === 'cedula');
check('ambos resuelven al mismo personId', a.personId === b.personId);

// el segundo registro rellenó el hueco "estado" sin pisar lo anterior
const merged = store.getPerson(a.personId)!;
check('merge enriquece huecos (estado vino del 2º silo)', merged.lastSeenState === 'La Guaira');
check('merge NO pisa la edad ya presente', merged.age === 34);

// --- E y V del mismo número NO se fusionan ---
const ext = resolvePerson(store, raw({ sourceId: 'X', fullName: 'Giuseppe Bianchi', cedula: 'E-12.345.678' }));
check('E-12345678 es persona distinta de V-12345678', ext.personId !== a.personId && ext.created);

// --- capa 2: sin cédula NUNCA fusiona automáticamente ---
const p1 = resolvePerson(store, raw({ sourceId: 'C1', fullName: 'Carlos Andrés Marín', age: 41, state: 'Distrito Capital' }));
const p2 = resolvePerson(store, raw({ sourceId: 'T7', fullName: 'Carlos Marín Andrés', age: 42, state: 'Distrito Capital' }));
check('sin cédula → dos personas distintas', p1.personId !== p2.personId);
check('sin cédula → ambas creadas', p1.created && p2.created);

// y ninguno provoca merge: siguen siendo registros separados.
check('sin cédula no provoca merge (siguen 2 registros)',
  store.getPerson(p1.personId) != null && store.getPerson(p2.personId) != null);

// --- nombres muy distintos sin cédula: no se sugieren entre sí (no rompe) ---
const q = resolvePerson(store, raw({ sourceId: 'Z1', fullName: 'María Fernanda Rodríguez', age: 28, state: 'Miranda' }));
check('persona sin relación se crea aparte', q.personId !== p1.personId && q.personId !== p2.personId);

// --- FALLBACK por silo: re-scrape del mismo sourceId NO duplica ---
const dom = 'silo.com';
const f1 = resolvePerson(store, raw({ sourceId: 'NOID-9', fullName: 'Pedro Sin Cédula', age: 50, state: 'Zulia' }), dom);
store.upsertSourceLink({
  personId: f1.personId, sourceDomain: dom, sourceId: 'NOID-9', sourceUrl: null,
  rawName: 'Pedro Sin Cédula', rawCedula: null, firstSeen: 't', lastSeen: 't',
});
const f2 = resolvePerson(store, raw({ sourceId: 'NOID-9', fullName: 'Pedro Sin Cédula', age: 50, state: 'Zulia' }), dom);
check('sin cédula: re-scrape del mismo silo+id reusa la persona', f2.personId === f1.personId && !f2.created && f2.matchedBy === 'source');

// --- el fallback NO cruza entre silos (otro silo = persona nueva) ---
const f3 = resolvePerson(store, raw({ sourceId: 'NOID-9', fullName: 'Pedro Sin Cédula', age: 50, state: 'Zulia' }), 'otro-silo.com');
check('sin cédula: otro silo NO auto-fusiona (persona nueva)', f3.personId !== f1.personId && f3.created);

// --- referencia: el "dónde fue hallado" (localizado + lugar concreto) gana sobre una ref vaga ---
const h1 = resolvePerson(store, raw({ sourceId: 'H1', fullName: 'Ana Hallada', cedula: 'V-9.111.222', reference: 'No lo sé', status: 'sin_contacto' }));
resolvePerson(store, raw({ sourceId: 'H2', fullName: 'Ana Hallada', cedula: '9111222', reference: 'Hospital Vargas · La Guaira', status: 'localizado' }));
check('ref: hospital (localizado) pisa una referencia vaga', store.getPerson(h1.personId)!.lastSeenRef === 'Hospital Vargas · La Guaira');

// pero NO pisa otro lugar concreto ya presente (evita churn entre fuentes)
resolvePerson(store, raw({ sourceId: 'H3', fullName: 'Ana Hallada', cedula: '9111222', reference: 'Hospital Periférico de Catia', status: 'localizado' }));
check('ref: no pisa un lugar concreto ya presente', store.getPerson(h1.personId)!.lastSeenRef === 'Hospital Vargas · La Guaira');

// una fuente sin_contacto NO pisa la referencia (aunque nombre un lugar): solo el hallazgo manda
const g1 = resolvePerson(store, raw({ sourceId: 'G1', fullName: 'Beto Vago', cedula: 'V-9.333.444', reference: 'Zona centro', status: 'sin_contacto' }));
resolvePerson(store, raw({ sourceId: 'G2', fullName: 'Beto Vago', cedula: '9333444', reference: 'Hospital Militar', status: 'sin_contacto' }));
check('ref: una fuente sin_contacto no pisa la referencia', store.getPerson(g1.personId)!.lastSeenRef === 'Zona centro');

// --- una fuente = UNA nota por registro: cambiar el estado PISA (no acumula rancio) ---
const flipAdapter = { domain: 'flip.com' } as unknown as SourceAdapter;
ingestRecords(store, flipAdapter, [raw({ sourceId: 'F', fullName: 'Flavia Flip', status: 'localizado' })]);
ingestRecords(store, flipAdapter, [raw({ sourceId: 'F', fullName: 'Flavia Flip', status: 'sin_contacto' })]);
const flipPid = store.getLinkBySource('flip.com', 'F')!.personId;
const flipNotes = store.notesForPerson(flipPid).filter((n) => n.sourceDomain === 'flip.com');
check('una fuente: cambiar estado PISA la nota (1 sola, sin localizado rancio)',
  flipNotes.length === 1 && flipNotes[0].status === 'sin_contacto');

console.log(`\n${pass} OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
