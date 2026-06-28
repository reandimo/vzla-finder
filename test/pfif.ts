/**
 * Feed público PFIF 1.4: estructura, escape XML, mapeo de estado y —crítico—
 * que NO exponga cédula ni PII.
 *   npx tsx test/pfif.ts
 */
import { Store } from '../src/db.ts';
import { resolvePerson } from '../src/dedup.ts';
import { consolidate } from '../src/reconcile.ts';
import { toPfif } from '../src/pfif.ts';
import type { RawRecord, Status } from '../src/types.ts';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? '✅' : '❌'} ${n}`); c ? pass++ : fail++; };

const store = new Store(':memory:');
const now = '2026-06-26T00:00:00Z';
function feed(domain: string, raw: RawRecord, status: Status) {
  const { personId } = resolvePerson(store, raw);
  store.upsertSourceLink({
    personId, sourceDomain: domain, sourceId: raw.sourceId, sourceUrl: `https://${domain}/p/${raw.sourceId}`,
    rawName: raw.fullName, rawCedula: raw.cedula ?? null, firstSeen: now, lastSeen: now,
  });
  store.addNote({
    noteId: `${domain}:${raw.sourceId}`, personId, sourceDomain: domain,
    status, noteText: null, sourceTimestamp: now, ingestedAt: now,
  });
}

feed('a.com', { sourceId: '1', fullName: 'José <Tom> & Pérez', cedula: 'V-12.345.678', age: 30, state: 'Miranda', city: 'Caracas' }, 'localizado');
feed('b.com', { sourceId: '2', fullName: 'Ana Gómez', age: 25 }, 'sin_contacto');

const persons = store.listPersons(50, 0).map((p) => consolidate(store, p));
const xml = toPfif(persons, { offset: 0, limit: 50, total: 2 });

check('es PFIF 1.4', xml.includes('xmlns:pfif="http://zesty.ca/pfif/1.4/"'));
check('incluye las 2 personas', (xml.match(/<pfif:person>/g) || []).length === 2);
check('NO expone el VALOR de la cédula (ni cruda, ni con puntos, ni normalizada)',
  !xml.includes('12345678') && !xml.includes('12.345.678') && !xml.includes('V12345678'));
check('escapa XML en el nombre', xml.includes('José &lt;Tom&gt; &amp; Pérez') && !xml.includes('<Tom>'));
check('localizado → believed_alive', xml.includes('believed_alive'));
check('sin_contacto → believed_missing', xml.includes('believed_missing'));
check('atribución de fuente original', xml.includes('<pfif:source_url>https://a.com/p/1</pfif:source_url>'));
check('metadatos de paginación', xml.includes('total=2') && xml.includes('Última página'));

console.log(`\n${pass} OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
