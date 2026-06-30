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
import { StatusVzlaAdapter } from '../src/sources/statusvzla.ts';
import { HospitalesAdapter } from '../src/sources/hospitales.ts';

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

// --- desaparecidos (API integradores "Reconexión"): JSON por cursor, CON cédula ---
const desap = new DesaparecidosTerremotoAdapter().parse(read('desaparecidos.json'));
const desapById = (id: string) => desap.find((r) => r.sourceId === id);
check('desap: ingiere fichas con nombre (omite vacíos)', desap.length === 3);
check('desap: cédula estructurada se usa como clave de merge',
  desapById('per_9f3a2b')?.cedula === 'V-12345678' && desapById('per_9f3a2b')?.age === 34);
check('desap: "sin-contacto" → sin_contacto', desapById('per_9f3a2b')?.status === 'sin_contacto');
check('desap: "localizado" → localizado', desapById('per_4c1d8e')?.status === 'localizado');
check('desap: cédula null → undefined (sin merge)', desapById('per_4c1d8e')?.cedula === undefined);
check('desap: ubicación → estado/ciudad (municipio o parroquia)',
  desapById('per_9f3a2b')?.state === 'Miranda' && desapById('per_9f3a2b')?.city === 'Baruta' &&
  desapById('per_4c1d8e')?.city === 'Maiquetía');
check('desap: referencia = descripción · centro',
  desapById('per_4c1d8e')?.reference === 'Atendida en el centro. · Hospital Universitario de Caracas');
check('desap: referencia cae a ubicacion.texto cuando no hay descripción/centro',
  desapById('per_7b1e3d')?.reference === 'Sector Los Cocos');
check('desap: foto absoluta de la API se conserva',
  (desapById('per_9f3a2b')?.photoUrl ?? '').startsWith('https://desaparecidos-terremoto-api.theempire.tech/uploads'));
check('desap: sin foto → undefined', desapById('per_4c1d8e')?.photoUrl === undefined);
check('desap: sourceUrl al sitio público', desapById('per_9f3a2b')?.sourceUrl === 'https://desaparecidosterremotovenezuela.com/');
check('desap: fecha → lastSeenAt; sin fecha cae a updatedAt (epoch→ISO)',
  desapById('per_9f3a2b')?.lastSeenAt === '2026-06-20' &&
  (desapById('per_4c1d8e')?.lastSeenAt ?? '').startsWith('2024-'));

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

// --- statusvzla: Base44 entities (buscadas + encontradas de hospital), sin cédula ---
const svzSample = JSON.stringify({
  buscadas: [
    { id: 'b1', nombre_completo: 'Oriana Ustaris ', edad_aprox: '25', estado_region: 'Distrito Capital ',
      ciudad: 'Caracas ', ultima_ubicacion_conocida: 'San Bernardino ', sexo: '',
      estado_caso: 'buscando', contacto_telefono: '04141234567', foto_url: null,
      created_date: '2026-06-28T20:51:35.566000', is_sample: false },
    { id: 'b2', nombre_completo: '', estado_caso: 'buscando', is_sample: false }, // sin nombre → omite
    { id: 'b3', nombre_completo: 'Demo Persona', estado_caso: 'buscando', is_sample: true }, // sample → omite
  ],
  encontradas: [
    { id: 'e1', nombre_o_descripcion: 'YARLYS CONTRERAS', condicion: 'no_identificado',
      nivel_verificacion: 'institucional', ubicacion_actual: 'Periférico de Catia',
      nombre_lugar: 'Periférico de Catia', tipo_lugar: 'hospital', estado_region: 'Distrito Capital',
      fuente: 'subida_masiva_institucional', foto_url: 'https://cdn.statusvzla.com/x.jpg', is_sample: false },
    { id: 'e2', nombre_o_descripcion: 'Negro Reyes', condicion: 'a_salvo', ubicacion_actual: 'hospital, las madres',
      tipo_lugar: 'refugio', is_sample: false },
    { id: 'e3', nombre_o_descripcion: 'Persona Sin Vida', condicion: 'fallecido', is_sample: false }, // deceso → omite
    { id: 'e4', nombre_o_descripcion: '', condicion: 'herido_leve', is_sample: false }, // sin nombre → omite
  ],
});
const svz = new StatusVzlaAdapter().parse(svzSample);
const svzById = (id: string) => svz.find((r) => r.sourceId === id);
check('statusvzla: ingiere buscadas + encontradas válidas (omite vacíos/sample/deceso)', svz.length === 3);
check('statusvzla: buscada "buscando" → sin_contacto, sin cédula, nombre/zona trim',
  svzById('b1')?.status === 'sin_contacto' && svzById('b1')?.cedula === undefined &&
  svzById('b1')?.fullName === 'Oriana Ustaris' && svzById('b1')?.state === 'Distrito Capital' &&
  svzById('b1')?.age === 25);
check('statusvzla: encontrada (hospital) → localizado, lugar como referencia',
  svzById('e1')?.status === 'localizado' && (svzById('e1')?.reference ?? '').includes('Periférico de Catia'));
check('statusvzla: foto absoluta se conserva', svzById('e1')?.photoUrl === 'https://cdn.statusvzla.com/x.jpg');
check('statusvzla: registro is_sample se descarta', !svz.some((r) => r.fullName === 'Demo Persona'));
check('statusvzla: condición FALLECIDO se excluye (nunca "a salvo")',
  !svz.some((r) => /Sin Vida/.test(r.fullName)));
check('statusvzla: sin cédula en ninguna entidad', svz.every((r) => r.cedula === undefined));
check('statusvzla: sourceUrl a /personas', svzById('b1')?.sourceUrl === 'https://statusvzla.com/personas');

// --- hospitales (62.146.225.76:9090): export FastAPI de pacientes, CON cédula ---
const hospSample = JSON.stringify({
  generado: '2026-06-29T04:43:05Z', total: 4,
  pacientes: [
    { id: 9, nombre_completo: 'Aleida Querales', cedula: '9928918', estado: null, edad: 61,
      sector: 'La Guaira', hospital: 'Cruz Roja Bellas Artes', processed_at: null },
    { id: 10, nombre_completo: 'ABRAAN VERGARA', cedula: null, estado: 'HOSPITAL', edad: 18,
      sector: null, hospital: 'Hospital Vargas' },
    { id: 11, nombre_completo: 'Persona Fallecida', cedula: '1234567', estado: 'Fallecido',
      hospital: 'Hospital Militar' }, // deceso → omite
    { id: 12, nombre_completo: '   ', cedula: null, estado: 'UCI', hospital: 'El Llanito' }, // sin nombre → omite
  ],
});
const hosp = new HospitalesAdapter().parse(hospSample);
const hospById = (id: string) => hosp.find((r) => r.sourceId === id);
check('hospitales: ingiere pacientes válidos (omite vacíos y fallecidos)', hosp.length === 2);
check('hospitales: todos localizado (hallados en hospital)', hosp.every((r) => r.status === 'localizado'));
check('hospitales: cédula estructurada se usa como clave de merge',
  hospById('9')?.cedula === '9928918' && hospById('9')?.age === 61);
check('hospitales: cédula null → undefined (sin merge)', hospById('10')?.cedula === undefined);
check('hospitales: referencia = hospital · sector', hospById('9')?.reference === 'Cruz Roja Bellas Artes · La Guaira');
check('hospitales: referencia solo hospital cuando no hay sector', hospById('10')?.reference === 'Hospital Vargas');
check('hospitales: FALLECIDO se excluye (nunca "a salvo")', !hosp.some((r) => /Fallecida/.test(r.fullName)));
check('hospitales: sourceUrl al sitio', hospById('9')?.sourceUrl === 'http://62.146.225.76:9090/');

console.log(`\n${pass} OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
