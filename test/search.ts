/**
 * Flujos de búsqueda (cédula exacta V-/E-, nombre fuzzy, homónimos, campos ricos).
 *   npm run test:search
 */
import { Store } from '../src/db.ts';
import { resolvePerson } from '../src/dedup.ts';
import { searchByCedula, searchByName } from '../src/search.ts';
import type { RawRecord } from '../src/types.ts';

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
const carlos = searchByName(store, 'carlos marin');
check('homónimos: devuelve a los dos Carlos', carlos.length === 2);
check('campos ricos para distinguir (edad + referencia)',
  carlos.some((p) => p.age === 41 && p.lastSeenRef === 'Los Palos Grandes') &&
  carlos.some((p) => p.age === 42));

// --- nombre: enriquecimiento por cédula visible en la búsqueda por nombre ---
const jose = searchByName(store, 'jose perez');
check('búsqueda por nombre trae la cédula consolidada', jose[0]?.cedula === 'V12345678');

// --- nombre: sin coincidencias razonables → vacío ---
check('nombre sin relación → 0 resultados', searchByName(store, 'zzz qqq').length === 0);

// --- límite ---
check('respeta el límite (limit=1)', searchByName(store, 'carlos marin', 1).length === 1);

console.log(`\n${pass} OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
