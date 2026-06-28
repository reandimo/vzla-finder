/**
 * Recall de candidatos para el desempate por IA (buildDupClusters).
 *   npm run test:recall
 *
 * Verifica que el blocking + nameSimilarity agrupe lo que PODRÍA ser la misma
 * persona (typos, orden de apellidos) sin barrer a personas claramente distintas.
 * Es recall, no decisión: agrupar de más acá lo corrige la IA después.
 */
import { buildDupClusters } from '../src/recall.ts';
import { normalizeName } from '../src/normalize.ts';
import type { PersonRecord } from '../src/types.ts';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? '✅' : '❌'} ${n}`); c ? pass++ : fail++; };

let seq = 0;
function person(fullName: string, cedula: string | null = null): PersonRecord {
  const id = `p${++seq}`;
  return {
    personId: id, cedula, fullName, nameNormalized: normalizeName(fullName),
    age: null, gender: null, lastSeenState: null, lastSeenCity: null,
    lastSeenRef: null, photoUrl: null, createdAt: '2026-06-28T00:00:00Z',
    updatedAt: '2026-06-28T00:00:00Z',
  };
}

const people = [
  person('Oriana Ustariz'),            // p1
  person('Oriana Uztaris'),            // p2  typo de apellido → mismo que p1
  person('ORIANA USTARIZ DINIS'),      // p3  superset → mismo que p1
  person('Oriana Ramírez'),            // p4  distinta (solo comparte primer nombre)
  person('Oriana Sivira'),             // p5  distinta
  person('Carlos Marín'),              // p6
  person('Marín Carlos'),              // p7  orden invertido → mismo que p6
  person('María González'),            // p8
  person('Maria Gonzales'),            // p9  typo de apellido común → mismo que p8 (prefijo)
  person('Pedro Pérez'),               // p10 solitario
];

const clusters = buildDupClusters(people);

function clusterOf(name: string) {
  const norm = normalizeName(name);
  return clusters.find((c) => c.members.some((m) => m.nameNormalized === norm));
}
function together(...names: string[]): boolean {
  const c = clusterOf(names[0]);
  if (!c) return false;
  return names.every((nm) => c.members.some((m) => m.nameNormalized === normalizeName(nm)));
}

check('agrupa typo de apellido (Ustariz/Uztaris)', together('Oriana Ustariz', 'Oriana Uztaris'));
check('agrupa superset de nombre (Ustariz Dinis)', together('Oriana Ustariz', 'ORIANA USTARIZ DINIS'));
check('NO agrupa solo por primer nombre (Ramírez)',
  !together('Oriana Ustariz', 'Oriana Ramírez'));
check('NO agrupa solo por primer nombre (Sivira)',
  !together('Oriana Ustariz', 'Oriana Sivira'));
check('Ramírez y Sivira tampoco entre sí', !together('Oriana Ramírez', 'Oriana Sivira'));
check('agrupa orden de apellidos invertido (Carlos Marín / Marín Carlos)',
  together('Carlos Marín', 'Marín Carlos'));
check('agrupa typo de apellido común con prefijo (González/Gonzales)',
  together('María González', 'Maria Gonzales'));
check('un solitario no forma cluster', clusterOf('Pedro Pérez') === undefined);
check('Ramírez y Sivira (solitarios) no forman cluster',
  clusterOf('Oriana Ramírez') === undefined && clusterOf('Oriana Sivira') === undefined);

// El cluster de Oriana Ustariz debe tener exactamente p1, p2, p3.
const ust = clusterOf('Oriana Ustariz');
check('cluster Ustariz tiene exactamente 3 miembros', ust?.members.length === 3);

console.log(`\n${pass} OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
