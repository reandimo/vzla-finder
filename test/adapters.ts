/**
 * Flujos de parseo por adaptador (cada fuente difiere: JSON, HTML, API).
 *   npm run test:adapters
 */
import { readFileSync } from 'node:fs';
import { VenezuelaTeBuscaAdapter } from '../src/sources/venezuelatebusca.ts';
import { DesaparecidosTerremotoAdapter } from '../src/sources/desaparecidos.ts';
import { EstoyAquiAdapter } from '../src/sources/estoyaqui.ts';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? '✅' : '❌'} ${n}`); c ? pass++ : fail++; };
const read = (rel: string) => readFileSync(new URL(`../fixtures/${rel}`, import.meta.url), 'utf8');

// --- venezuelatebusca: JSON con cédula ---
const vtb = new VenezuelaTeBuscaAdapter().parse(read('venezuelatebusca.json'));
check('vtb: parsea todos los registros del fixture', vtb.length === 4);
check('vtb: trae cédula donde existe', vtb.filter((r) => r.cedula).length >= 2);
check('vtb: incluye al extranjero E-', vtb.some((r) => (r.cedula ?? '').startsWith('E-')));
check('vtb: estatus "sin contacto" → sin_contacto', vtb.some((r) => r.status === 'sin_contacto'));

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

console.log(`\n${pass} OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
