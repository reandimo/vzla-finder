/**
 * Registro de fuentes. Agregar un silo = crear su adaptador y sumarlo acá.
 * Cada uno declara su propio config (intervalo, cortesía) y su propio parseo.
 */
import type { SourceAdapter } from '../types.ts';
import { VenezuelaTeBuscaAdapter } from './venezuelatebusca.ts';
import { EstoyAquiAdapter } from './estoyaqui.ts';
import { DesaparecidosVenezuelaAdapter } from './desaparecidosvenezuela.ts';
import { AfectadosAdapter } from './afectados.ts';
import { VenezuelaReportaAdapter } from './venezuelareporta.ts';
import { VzlanosAdapter } from './vzlanos.ts';
import { StatusVzlaAdapter } from './statusvzla.ts';
import { HospitalesAdapter } from './hospitales.ts';

// Solo fuentes con scraping REAL: no inyectamos datos sintéticos en producción.
//
// desaparecidos.ts NO se incluye: su API exige verificación reCAPTCHA, así que
// no es scrapeable por automatización (respetamos su protección). El adaptador
// y su fixture quedan para los tests. venezuelareporta.org (API Supabase) es la
// próxima candidata a sumar.
export const adapters: SourceAdapter[] = [
  new VenezuelaTeBuscaAdapter(),       // React Router /_root.data (turbo-stream), trae cédula
  new EstoyAquiAdapter(),              // API JSON /api/datos (buscadas + encontradas), trae cédula
  new DesaparecidosVenezuelaAdapter(), // API JSON /api/personas (sin cédula), trae lat/lng
  new AfectadosAdapter(),              // HTML/SSR multipágina (cédula enmascarada = pista)
  new VenezuelaReportaAdapter(),       // HTML/SSR paginado (sin cédula), UUID por ficha, incremental
  new VzlanosAdapter(),                // API JSON /api/personas paginada (cédula enmascarada = sin merge)
  new StatusVzlaAdapter(),             // Base44 entities (buscadas + encontradas de hospital), sin cédula
  new HospitalesAdapter(),             // FastAPI export pacientes de hospital (localizado), CON cédula
];
