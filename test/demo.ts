/**
 * Demo de extremo a extremo: simula DOS silos distintos reportando gente, y
 * verifica las tres garantías del agregador.
 *
 *   npm run demo
 */
import { Store } from '../src/db.ts';
import { resolvePerson } from '../src/dedup.ts';
import { consolidate } from '../src/reconcile.ts';
import { searchByCedula, searchByName } from '../src/search.ts';
import type { RawRecord } from '../src/types.ts';

const store = new Store(':memory:');
const now = () => new Date().toISOString();

function feed(domain: string, raw: RawRecord, status: RawRecord['status']) {
  const { personId } = resolvePerson(store, raw);
  store.upsertSourceLink({
    personId,
    sourceDomain: domain,
    sourceId: raw.sourceId,
    sourceUrl: `https://${domain}/p/${raw.sourceId}`,
    rawName: raw.fullName,
    rawCedula: raw.cedula ?? null,
    firstSeen: now(),
    lastSeen: now(),
  });
  store.addNote({
    noteId: `${domain}:${raw.sourceId}`,
    personId,
    sourceDomain: domain,
    status: status ?? 'sin_contacto',
    noteText: null,
    sourceTimestamp: now(),
    ingestedAt: now(),
  });
  return personId;
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  cond ? pass++ : fail++;
}

// --- Escenario 1: misma persona (misma cédula) en DOS silos distintos ---
feed('venezuelatebusca.com',
  { sourceId: 'A1', fullName: 'José Gabriel Pérez', cedula: 'V-12.345.678', age: 34, state: 'La Guaira' },
  'sin_contacto');
feed('desaparecidosterremotovenezuela.com',
  { sourceId: 'X9', fullName: 'Jose Perez', cedula: '12345678', age: 34, state: 'La Guaira' },
  'sin_contacto');

const jose = searchByCedula(store, 'V12345678')!;
check('cédula: un solo registro pese a venir de 2 silos', jose != null);
check('cédula: dedup ignora acentos/formato/orden de nombre', jose.sources.length === 2);
check('cédula: conserva procedencia de ambas fuentes',
  jose.sources.map((s) => s.sourceDomain).sort().join(',') ===
  'desaparecidosterremotovenezuela.com,venezuelatebusca.com');

// --- Escenario 2: la "buena noticia gana" (un silo lo marca localizado) ---
feed('venezuelareporta.org',
  { sourceId: 'R4', fullName: 'José Gabriel Pérez', cedula: '12.345.678', age: 34, state: 'La Guaira' },
  'localizado');

const joseAfter = searchByCedula(store, 'V12345678')!;
check('estado: "localizado" de cualquier fuente consolida a salvo',
  joseAfter.consolidatedStatus === 'localizado');
check('estado: registra qué fuente dio la buena noticia',
  joseAfter.resolvedBy === 'venezuelareporta.org');

// --- Escenario 3: SIN cédula → sugerencia, NUNCA merge automático ---
const p1 = feed('venezuelatebusca.com',
  { sourceId: 'B1', fullName: 'Carlos Andrés Marín', age: 41, state: 'Distrito Capital' },
  'sin_contacto');
const p2 = feed('terremotovenezuela.com',
  { sourceId: 'T7', fullName: 'Carlos Marin Andres', age: 42, state: 'Distrito Capital' },
  'sin_contacto');

check('sin cédula: NO se fusionan (siguen siendo 2 personas distintas)', p1 !== p2);

const carlos = searchByName(store, 'Carlos Marin').results;
check('sin cédula: ambos aparecen en búsqueda por nombre', carlos.length >= 2);

// --- Escenario 4: persona común sin cédula no contamina a otra ---
feed('venezuelatebusca.com',
  { sourceId: 'C1', fullName: 'María Fernanda Rodríguez', age: 28, state: 'Miranda' },
  'sin_contacto');
const maria = searchByName(store, 'Maria Rodriguez').results;
check('búsqueda por nombre devuelve a la persona correcta',
  maria.some((m) => m.fullName.includes('María Fernanda')));

// --- Escenario 5: extranjero (cédula E-) se busca igual y NO colisiona con V ---
feed('venezuelatebusca.com',
  { sourceId: 'E1', fullName: 'Giuseppe Antonio Bianchi', cedula: 'E-84.111.222', age: 53, state: 'La Guaira' },
  'sin_contacto');

const giuseppe = searchByCedula(store, 'E-84.111.222');
check('extranjero: cédula E- se encuentra', giuseppe != null);
check('extranjero: conserva el prefijo E en la forma canónica',
  giuseppe?.cedula === 'E84111222');
check('extranjero: E-84.111.222 NO colisiona con un V-84.111.222 inexistente',
  searchByCedula(store, 'V-84.111.222') == null);

console.log(`\n${pass} pruebas OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
