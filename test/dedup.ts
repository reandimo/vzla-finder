/**
 * Flujos de deduplicación (capa cédula = merge; sin cédula = sugerencia).
 *   npm run test:dedup
 */
import { Store } from '../src/db.ts';
import { resolvePerson } from '../src/dedup.ts';
import type { RawRecord } from '../src/types.ts';

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

console.log(`\n${pass} OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
