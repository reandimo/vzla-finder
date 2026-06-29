/**
 * Flujos de búsqueda (cédula exacta V-/E-, nombre fuzzy, homónimos, campos ricos).
 *   npm run test:search
 */
import { Store } from '../src/db.ts';
import { resolvePerson } from '../src/dedup.ts';
import { searchByCedula, searchByName, tagDuplicates } from '../src/search.ts';
import { normalizeName } from '../src/normalize.ts';
import type { RawRecord, ConsolidatedPerson } from '../src/types.ts';

/** Persona consolidada mínima para probar tagDuplicates de forma directa. */
function cp(fullName: string, cedula: string | null = null, extra: Partial<ConsolidatedPerson> = {}): ConsolidatedPerson {
  return {
    fullName, cedula, nameNormalized: normalizeName(fullName),
    consolidatedStatus: 'sin_contacto', sources: [], ...extra,
  } as unknown as ConsolidatedPerson;
}

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? '✅' : '❌'} ${n}`); c ? pass++ : fail++; };

const store = new Store(':memory:');
const now = '2026-06-26T00:00:00Z';
function feed(domain: string, raw: RawRecord) {
  const { personId } = resolvePerson(store, raw);
  store.upsertSourceLink({
    personId, sourceDomain: domain, sourceId: raw.sourceId, sourceUrl: `https://${domain}/p/${raw.sourceId}`,
    rawName: raw.fullName, rawCedula: raw.cedula ?? null, firstSeen: now, lastSeen: now,
  });
  store.addNote({
    noteId: `${domain}:${raw.sourceId}`, personId, sourceDomain: domain,
    status: raw.status ?? 'sin_contacto', noteText: null, sourceTimestamp: now, ingestedAt: now,
  });
}

feed('a.com', { sourceId: '1', fullName: 'José Gabriel Pérez', cedula: 'V-12.345.678', age: 34, state: 'La Guaira', reference: 'Maiquetía' });
feed('b.com', { sourceId: '2', fullName: 'Giuseppe Bianchi', cedula: 'E-84.111.222', age: 53, state: 'La Guaira' });
feed('a.com', { sourceId: '3', fullName: 'Carlos Andrés Marín', age: 41, state: 'Distrito Capital', reference: 'Los Palos Grandes' });
feed('b.com', { sourceId: '4', fullName: 'Carlos Marín Andrés', age: 42, state: 'Distrito Capital' });

// --- cédula exacta, tolerante al formato ---
check('cédula con puntos/guion encuentra', searchByCedula(store, 'V-12.345.678')?.fullName === 'José Gabriel Pérez');
check('cédula sin formato encuentra igual', searchByCedula(store, 'v12345678') != null);
check('cédula inexistente → null', searchByCedula(store, 'V-99.999.999') === null);

// --- extranjero E- y NO colisión con V- ---
check('extranjero E- encuentra', searchByCedula(store, 'E-84.111.222')?.fullName === 'Giuseppe Bianchi');
check('V- del mismo número NO trae al extranjero', searchByCedula(store, 'V-84.111.222') === null);

// --- nombre: homónimos, ambos vuelven y son distinguibles ---
const carlos = searchByName(store, 'carlos marin').results;
check('homónimos: devuelve a los dos Carlos', carlos.length === 2);
check('campos ricos para distinguir (edad + referencia)',
  carlos.some((p) => p.age === 41 && p.lastSeenRef === 'Los Palos Grandes') &&
  carlos.some((p) => p.age === 42));

// --- nombre: enriquecimiento por cédula visible en la búsqueda por nombre ---
const jose = searchByName(store, 'jose perez').results;
check('búsqueda por nombre trae la cédula consolidada', jose[0]?.cedula === 'V12345678');

// --- nombre: sin coincidencias razonables → vacío ---
check('nombre sin relación → 0 resultados', searchByName(store, 'zzz qqq').results.length === 0);

// --- límite y total ---
const lim = searchByName(store, 'carlos marin', 1);
check('respeta el límite (limit=1)', lim.results.length === 1);
check('total refleja todas las coincidencias aunque se recorten', lim.total === 2);

// --- etiqueta "posible duplicado": marca (sin fusionar) los que probablemente
// son la misma persona; NO agrupa por compartir solo el primer nombre, ni dos
// con cédulas distintas. ---
feed('s1.com', { sourceId: 'o1', fullName: 'Oriana Ustariz', age: 25 });
feed('s2.com', { sourceId: 'o2', fullName: 'ORIANA USTARIZ', age: 25 });
feed('s3.com', { sourceId: 'o3', fullName: 'Oriana Andrea Ustariz Dinis', cedula: 'V-27.770.896', age: 25 });
feed('s4.com', { sourceId: 'o4', fullName: 'Oriana Ramírez', age: 25 });
const oriana = searchByName(store, 'oriana ustariz').results;
const ust = oriana.filter((p) => /ustariz/i.test(p.fullName));
const ram = oriana.find((p) => /ram[ií]rez/i.test(p.fullName));
check('dup: agrupa las 3 "… Ustariz" (≥2 tokens compartidos)',
  ust.length === 3 && ust.every((p) => p.dupCount === 3 && p.dupGroup === ust[0].dupGroup && p.dupGroup != null));
check('dup: NO agrupa "Oriana Ramírez" (solo comparte el primer nombre)',
  ram != null && ram.dupGroup === null && ram.dupCount === 1);

feed('s1.com', { sourceId: 'm1', fullName: 'Marcos Test Lopez', cedula: 'V-1.000.001' });
feed('s2.com', { sourceId: 'm2', fullName: 'Marcos Test Lopez', cedula: 'V-2.000.002' });
const marcos = searchByName(store, 'marcos test lopez').results;
check('dup: dos cédulas DISTINTAS no se marcan como duplicado',
  marcos.length === 2 && marcos.every((p) => p.dupGroup === null));

// --- regresión (falso negativo a escala): con MUCHÍSIMAS coincidencias de un
// solo token, la persona que matchea TODOS los tokens debe sobrevivir al corte
// de candidatos. Si no, una familia buscando "Nombre Apellido" no la encontraría
// aunque esté en la base. Insertamos 850 ruidos "… Pérez" + 1 target añadido al
// final (rowid alto, el que un LIMIT sin orden descartaría primero). ---
for (let i = 0; i < 850; i++) {
  feed('noise.com', { sourceId: `n${i}`, fullName: 'Pedro Perez', cedula: `V-1${String(i).padStart(7, '0')}` });
}
feed('z.com', { sourceId: 'target', fullName: 'Mariangel Perez', cedula: 'V-29.999.999', age: 22, state: 'Vargas' });
const needle = searchByName(store, 'mariangel perez').results;
check('match completo sobrevive entre 850 ruidos de un token (no falso negativo)',
  needle.some((p) => p.fullName === 'Mariangel Perez'));

// --- agrupado: NO encadenar homónimos distintos en un "blob" ---
// Con union-find transitivo, A-B y B-C unían a A con C aunque A y C no se parezcan.
// Con linkage contra representante, C debe parecerse al ANCLA, no a un vecino.
const chain = tagDuplicates([
  cp('Cesar Pacheco'),        // ancla
  cp('Julio Cesar Pacheco'),  // comparte cesar+pacheco con el ancla → mismo grupo
  cp('Eva Julio Pacheco'),    // comparte julio+pacheco con el del medio, pero solo pacheco con el ancla
]);
const aCesar = chain.find((p) => p.fullName === 'Cesar Pacheco')!;
const aEva = chain.find((p) => p.fullName === 'Eva Julio Pacheco')!;
check('agrupado: NO encadena homónimos (Cesar Pacheco ≠ grupo de Eva Julio Pacheco)',
  aCesar.dupGroup == null || aCesar.dupGroup !== aEva.dupGroup);

// --- agrupado: compartir 2 nombres COMUNES con apellido propio distinto → NO agrupa ---
const comunes = tagDuplicates([
  cp('Julio César Diaz'),
  cp('Julio César Cruz'),
  cp('Julio César Peña'),
]);
check('agrupado: "Julio César Diaz/Cruz/Peña" NO se agrupan (apellido propio distinto)',
  new Set(comunes.map((p) => p.dupGroup ?? Symbol())).size === comunes.length);
// pero el subconjunto SÍ: "Oriana Ustariz" ⊆ "Oriana Ustariz Dinis"
const contiene = tagDuplicates([cp('Oriana Ustariz Dinis'), cp('Oriana Ustariz')]);
check('agrupado: nombre contenido en otro más largo → mismo grupo',
  contiene[0].dupGroup != null && contiene[0].dupGroup === contiene[1].dupGroup);

// --- agrupado: dos cédulas DISTINTAS no se agrupan deterministamente, ni siquiera
// si son "casi iguales" + nombre parecido. Un typo de cédula + typo de nombre puede
// ser OTRA persona; ese juicio multicampo lo hace la IA con contexto, no esta regla. ---
const casiIgual = tagDuplicates([
  cp('Veronica Bastardo', 'V30170686', { consolidatedStatus: 'localizado' } as any),
  cp('Veronica Bastido', 'V30170626'), // cédula a distancia 1 + apellido con typo
]);
check('agrupado: cédula+nombre "casi iguales" NO se agrupan deterministamente (es juicio de la IA)',
  casiIgual[0].dupGroup === null && casiIgual[1].dupGroup === null);

// --- IA como capa de confianza sobre el agrupado (nunca fusiona) ---
// Helper: cp con personId para poder indexar veredictos por par.
function cpid(id: string, fullName: string, cedula: string | null = null, extra: Partial<ConsolidatedPerson> = {}) {
  return cp(fullName, cedula, { personId: id, ...extra } as Partial<ConsolidatedPerson>);
}
const verdict = (a: string, b: string, v: 'same' | 'different', confidence: number) =>
  ({ personIdA: a, personIdB: b, verdict: v, confidence, reason: null, model: 'test', pairHash: '', createdAt: '' });

// (1) "same" con confianza alta JUNTA lo que el nombre-contención perdería
// (typo de apellido: Ustariz/Uztaris no es contención, pero la IA dice misma persona).
{
  const lookup = (a: string, b: string) =>
    ((a === 'p1' && b === 'p2') || (a === 'p2' && b === 'p1'))
      ? verdict('p1', 'p2', 'same', 0.9) : null;
  const grouped = tagDuplicates([
    cpid('p1', 'Oriana Ustariz'),
    cpid('p2', 'Oriana Uztaris'), // typo: comparte solo "oriana" → sin IA NO agruparía
  ], lookup);
  check('IA: "same" (conf alta) agrupa typos que el nombre solo no une',
    grouped[0].dupGroup != null && grouped[0].dupGroup === grouped[1].dupGroup);
  check('IA: el miembro no-representante expone aiConfidence',
    grouped.some((p) => p.aiConfidence === 0.9) && grouped.some((p) => p.aiConfidence === null));
}

// (2) "different" con confianza alta SEPARA homónimos que el nombre uniría
// (contención perfecta de nombre, pero la IA dice que son personas distintas).
{
  const lookup = (a: string, b: string) =>
    ((a === 'q1' && b === 'q2') || (a === 'q2' && b === 'q1'))
      ? verdict('q1', 'q2', 'different', 0.85) : null;
  const split = tagDuplicates([
    cpid('q1', 'Maria Gonzalez', null, { age: 20 } as any),
    cpid('q2', 'Maria Gonzalez', null, { age: 70 } as any), // mismo nombre, edad muy distinta
  ], lookup);
  check('IA: "different" (conf alta) separa homónimos que el nombre uniría',
    split[0].dupGroup === null && split[1].dupGroup === null);
}

// (3) confianza BAJA NO pesa: manda la regla determinista (nombre-contención).
{
  const lookup = () => verdict('r1', 'r2', 'same', 0.3); // por debajo del umbral
  const weak = tagDuplicates([
    cpid('r1', 'Pedro Linares'),
    cpid('r2', 'Pedro Rojas'), // solo comparte "pedro" → sin contención
  ], lookup);
  check('IA: "same" con confianza baja NO agrupa (manda lo determinista)',
    weak[0].dupGroup === null && weak[1].dupGroup === null);
}

console.log(`\n${pass} OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
