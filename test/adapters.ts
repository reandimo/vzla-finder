/**
 * Flujos de parseo por adaptador (cada fuente difiere: JSON, HTML, API).
 *   npm run test:adapters
 */
import { readFileSync } from 'node:fs';
import { VenezuelaTeBuscaAdapter, unflatten } from '../src/sources/venezuelatebusca.ts';
import { DesaparecidosTerremotoAdapter } from '../src/sources/desaparecidos.ts';
import { EstoyAquiAdapter } from '../src/sources/estoyaqui.ts';
import { DesaparecidosVenezuelaAdapter } from '../src/sources/desaparecidosvenezuela.ts';
import { AfectadosAdapter } from '../src/sources/afectados.ts';
import { VenezuelaReportaAdapter } from '../src/sources/venezuelareporta.ts';
import { VzlanosAdapter } from '../src/sources/vzlanos.ts';

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

// --- estoyaqui: API /api/datos (buscadas + encontradas; excluye fallecidos) ---
const eaqSample = JSON.stringify([{
  totales: { personas_buscadas: 2, personas_encontradas: 3 },
  personas_buscadas: [
    { id: 5, nombre_completo: 'Carla Ríos', cedula: '12345678', edad: 30,
      ultima_ubicacion: 'Caribe, La Guaira', estado: 'buscando', fecha_reporte: '2026-06-26T10:00:00Z' },
    { id: 6, nombre_completo: '', cedula: null, edad: null, estado: 'buscando' },
  ],
  personas_encontradas: [
    { id: 23, nombre_completo: 'Burlis Sno', cedula: '10481980', edad_aproximada: 53,
      descripcion_fisica: 'Atendido en Traumatología', ubicacion_actual: 'HAFPL2, La Guaira',
      estado_salud: 'herido_leve', fecha_reporte: '2026-06-25T20:31:15Z' },
    { id: 24, nombre_completo: 'Persona Sin Vida', cedula: null, edad_aproximada: 40,
      estado_salud: 'fallecido', ubicacion_actual: 'Morgue' },
    { id: 25, nombre_completo: '', cedula: null, estado_salud: 'sano' },
  ],
}]);
const eaq = new EstoyAquiAdapter().parse(eaqSample);
const eaqById = (id: string) => eaq.find((r) => r.sourceId === id);
check('estoyaqui: ingiere buscadas + encontradas válidas (omite vacíos)', eaq.length === 2);
check('estoyaqui: buscada → sin_contacto, sourceId b-<id>, con cédula',
  eaqById('b-5')?.status === 'sin_contacto' && eaqById('b-5')?.cedula === '12345678');
check('estoyaqui: encontrada → localizado, id numérico, cédula y edad_aproximada',
  eaqById('23')?.status === 'localizado' && eaqById('23')?.cedula === '10481980' && eaqById('23')?.age === 53);
check('estoyaqui: ubicación → referencia', (eaqById('23')?.reference ?? '').includes('HAFPL2'));
check('estoyaqui: FALLECIDO se excluye (nunca "a salvo")',
  !eaq.some((r) => /Sin Vida/.test(r.fullName)));

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

// --- afectados: HTML/SSR multipágina, cédula enmascarada como pista (no merge) ---
const afAdapter = new AfectadosAdapter();
const desapHtml = read('afectados.html');
const af = afAdapter.parse(JSON.stringify([
  { path: '/desaparecidos', status: 'sin_contacto', html: desapHtml },
]));
check('afectados: scrapea las 2 cards', af.length === 2);
check('afectados: nombre y edad', af[0].fullName === 'Donis María Roque Tovar' && af[0].age === 44);
check('afectados: página desaparecidos → sin_contacto', af.every((r) => r.status === 'sin_contacto'));
check('afectados: cédula enmascarada NO va a cedula (sin merge)', af.every((r) => r.cedula === undefined));
check('afectados: cédula parcial queda como pista en la referencia',
  (af[0].reference ?? '').includes('Cédula parcial: V-14.XXX.917'));
check('afectados: "No registrada" no genera pista de cédula',
  !(af[1].reference ?? '').includes('Cédula parcial'));
check('afectados: última actualización → ISO con offset Venezuela',
  af[0].lastSeenAt === '2026-06-26T10:42:00-04:00');
check('afectados: foto Supabase se conserva absoluta',
  (af[0].photoUrl ?? '').startsWith('https://wnvnkjitwmjlrjhkoiud.supabase.co'));
check('afectados: id estable entre corridas',
  afAdapter.parse(JSON.stringify([{ path: '/desaparecidos', status: 'sin_contacto', html: desapHtml }]))[0].sourceId === af[0].sourceId);

// Estado por página: hospitalizados/rescatados → localizado; fallecido se descarta.
const afLoc = afAdapter.parse(JSON.stringify([
  { path: '/hospitalizados', status: 'localizado', html:
    '<div class="rounded-xl"><h3 class="font-bold">Martinez Gabriel</h3>' +
    '<span>Hospitalizado</span><span>Cédula: No registrada</span>' +
    '<span>Centro médico: Caracas, Distrito Capital</span></div>' },
  { path: '/fallecidos', status: 'localizado', html:
    '<div class="rounded-xl"><h3 class="font-bold">Persona Fallecida</h3><span>Fallecido</span></div>' },
]));
check('afectados: hospitalizado → localizado', afLoc.length === 1 && afLoc[0].status === 'localizado');
check('afectados: card "Fallecido" se descarta', !afLoc.some((r) => /Fallecida/.test(r.fullName)));

// --- venezuelareporta: HTML/SSR paginado, UUID por ficha, sin cédula ---
const vr = new VenezuelaReportaAdapter().parse(JSON.stringify([read('venezuelareporta.html')]));
check('vr: scrapea las 2 tarjetas', vr.length === 2);
check('vr: sourceId = UUID de la ficha', vr[0].sourceId === 'f21e2ec9-4cd5-4142-8a2e-1fe53d71a02e');
check('vr: sourceUrl apunta a /reporte/<uuid>',
  vr[0].sourceUrl === 'https://venezuelareporta.org/reporte/f21e2ec9-4cd5-4142-8a2e-1fe53d71a02e');
check('vr: nombre y edad desde la línea meta', vr[0].fullName === 'Olivia perez Hernández' && vr[0].age === 28);
check('vr: referencia = meta sin la edad', vr[0].reference === 'La guaira · Los corales');
check('vr: "Se busca" → sin_contacto', vr[0].status === 'sin_contacto');
check('vr: "A salvo" → localizado', vr[1].status === 'localizado');
check('vr: sin cédula', vr.every((r) => r.cedula === undefined));
check('vr: foto Supabase absoluta', (vr[0].photoUrl ?? '').startsWith('https://wlvcfbuxkdrxhxqlwwmo.supabase.co'));

// --- vzlanos: API /api/personas paginada, sin cédula utilizable ---
const vzlSample = JSON.stringify({
  items: [
    { id: 88, nombre: 'Víctor Jiménez', edad: 60, ubicacion: 'Cerca de Bellevue',
      fecha: '2026-06-28T13:34:36.787Z', descripcion: null, contacto: '04125527222',
      foto: '/api/reports/88/photo', estado: 'sin-contacto' },
    { id: 82, nombre: 'Verónica Seabra', edad: null, ubicacion: null, descripcion: 'Estoy bien',
      foto: null, estado: 'localizado', localizadoPor: 'Auto-reporte' },
    { id: 99, nombre: '', estado: 'sin-contacto' },
  ],
  total: 3, page: 1, pageSize: 100, totalPages: 1,
});
const vzl = new VzlanosAdapter().parse(vzlSample);
check('vzlanos: ingiere items con nombre (omite vacíos)', vzl.length === 2);
check('vzlanos: "sin-contacto" → sin_contacto', vzl[0].status === 'sin_contacto');
check('vzlanos: "localizado" → localizado', vzl[1].status === 'localizado');
check('vzlanos: foto relativa → absoluta vzlanos.com',
  (vzl[0].photoUrl ?? '') === 'https://vzlanos.com/api/reports/88/photo');
check('vzlanos: no expone cédula (enmascarada en la fuente)', vzl.every((r) => r.cedula === undefined));
check('vzlanos: sourceId = id, sourceUrl a /desaparecidos',
  vzl[0].sourceId === '88' && vzl[0].sourceUrl === 'https://vzlanos.com/desaparecidos');
check('vzlanos: edad numérica, null → undefined',
  vzl[0].age === 60 && vzl[1].age === undefined);

console.log(`\n${pass} OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
