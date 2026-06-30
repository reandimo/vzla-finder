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
import { DesaparecidosTerremotoAdapter } from './desaparecidos.ts';

// Solo fuentes con scraping REAL: no inyectamos datos sintéticos en producción.
//
// desaparecidos.ts ahora SÍ se incluye: ya no se scrapea el sitio (protegido por
// reCAPTCHA), sino su API oficial de integradores por convenio (key en
// DESAPARECIDOS_API_KEY). Sin la key la fuente se salta sola (el runner aísla el
// error y sigue con las demás).
export const adapters: SourceAdapter[] = [
  new VenezuelaTeBuscaAdapter(),       // React Router /_root.data (turbo-stream), trae cédula
  new EstoyAquiAdapter(),              // API JSON /api/datos (buscadas + encontradas), trae cédula
  new DesaparecidosVenezuelaAdapter(), // API JSON /api/personas (sin cédula), trae lat/lng
  new AfectadosAdapter(),              // HTML/SSR multipágina (cédula enmascarada = pista)
  new VenezuelaReportaAdapter(),       // HTML/SSR paginado (sin cédula), UUID por ficha, incremental
  new VzlanosAdapter(),                // API JSON /api/personas paginada (cédula enmascarada = sin merge)
  new StatusVzlaAdapter(),             // Base44 entities (buscadas + encontradas de hospital), sin cédula
  new HospitalesAdapter(),             // FastAPI export pacientes de hospital (localizado), CON cédula
  new DesaparecidosTerremotoAdapter(), // API integradores "Reconexión" /personas (cursor), CON cédula
];
