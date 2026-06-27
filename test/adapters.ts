/**
 * Flujos de parseo por adaptador (cada fuente difiere: JSON, HTML, API).
 *   npm run test:adapters
 */
import { readFileSync } from 'node:fs';
import { VenezuelaTeBuscaAdapter, unflatten } from '../src/sources/venezuelatebusca.ts';
import { DesaparecidosTerremotoAdapter } from '../src/sources/desaparecidos.ts';
import { EstoyAquiAdapter } from '../src/sources/estoyaqui.ts';
import { DesaparecidosVenezuelaAdapter } from '../src/sources/desaparecidosvenezuela.ts';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? '✅' : '❌'} ${n}`); c ? pass++ : fail++; };
const read = (rel: string) => readFileSync(new URL(`../fixtures/${rel}`, import.meta.url), 'utf8');

// --- venezuelatebusca: turbo-stream (React Router /_root.data) con cédula ---
check('unflatten: resuelve clave/valor por índice', unflatten([{ _1: 2 }, 'k', 'v']).k === 'v');
const ts = [
  { _1: 2 }, 'persons', [3],
  { _4: 5, _6: 7, _8: 9, _10: 11, _12: 13, _14: 15, _16: 17 },
  'id', 'p-1', 'firstName', 'Ana', 'lastName', 'Lopez',
  'idNumber', 'V-7.654.321', 'age', 30, 'status', 'missing',
  'photoUrl', '/media/photos/x.webp',
];
const body = JSON.stringify([JSON.stringify(ts)]);
const vtb = new VenezuelaTeBuscaAdapter().parse(body);
check('vtb: decodifica turbo-stream y arma el nombre', vtb.length === 1 && vtb[0].fullName === 'Ana Lopez');
check('vtb: idNumber → cédula', vtb[0].cedula === 'V-7.654.321');
check('vtb: status "missing" → sin_contacto', vtb[0].status === 'sin_contacto');
check('vtb: photoUrl se vuelve absoluta', (vtb[0].photoUrl ?? '').startsWith('https://venezuelatebusca.com/media/photos'));

// --- desaparecidos: HTML con cheerio ---
const desap = new DesaparecidosTerremotoAdapter().parse(read('desaparecidos-terremoto.html'));
check('desap: scrapea las 3 fichas del listado', desap.length === 3);
check('desap: extrae nombre y cédula', desap[0].fullName === 'Jose Gabriel Perez' && !!desap[0].cedula);
check('desap: data-estatus="localizado" → localizado', desap.some((r) => r.status === 'localizado'));
check('desap: ficha sin cédula → cedula undefined', desap.some((r) => r.cedula === undefined));

// --- estoyaqui: API /api/encontradas (forma real) ---
const sample = JSON.stringify({
  total: 2,
  items: [
    { id: 23, nombre_completo: 'Burlis Sno', cedula: '10481980', edad_aproximada: 53,
      descripcion_fisica: 'Atendido en Traumatología', ubicacion_actual: 'HAFPL2, La Guaira',
      estado_salud: 'herido_leve', fecha_reporte: '2026-06-25T20:31:15Z' },
    { id: 24, nombre_completo: '', cedula: null, edad_aproximada: null, estado_salud: 'estable' },
  ],
});
const eaq = new EstoyAquiAdapter().parse(sample);
check('estoyaqui: lee el array items', eaq.length === 2);
check('estoyaqui: encontrados → status localizado', eaq[0].status === 'localizado');
check('estoyaqui: mapea edad_aproximada → age', eaq[0].age === 53);
check('estoyaqui: mapea cédula y ubicación como referencia',
  eaq[0].cedula === '10481980' && (eaq[0].reference ?? '').includes('HAFPL2'));

// --- desaparecidosvenezuela: API /api/personas (sin cédula, estado/actualizaciones) ---
const dvz = new DesaparecidosVenezuelaAdapter().parse(read('desaparecidosvenezuela.json'));
check('dvz: ingiere visibles y omite ocultos', dvz.length === 2);
check('dvz: zona → estado/ciudad', dvz[0].state === 'La Guaira' && dvz[0].city === 'La Guaira (centro)');
check('dvz: descripción/zona → referencia', dvz[0].reference === 'Edificio palafito del mar');
check('dvz: BUSCADO sin actualización → sin_contacto', dvz[0].status === 'sin_contacto');
check('dvz: actualización ENCONTRADO → localizado', dvz[1].status === 'localizado');
check('dvz: no expone cédula', dvz.every((r) => r.cedula === undefined));
check('dvz: fotoUrl relativa → absoluta',
  (dvz[0].photoUrl ?? '').startsWith('https://www.desaparecidosvenezuela.com/api/personas'));
check('dvz: sourceUrl apunta a la ficha /p/<id>',
  dvz[0].sourceUrl === 'https://www.desaparecidosvenezuela.com/p/des-1');

console.log(`\n${pass} OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
