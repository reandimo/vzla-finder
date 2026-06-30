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
// DesaparecidosTerremotoAdapter (API integradores "Reconexión", desaparecidos.ts):
// integrada y VERIFICADA (key + mapeo OK contra data viva), pero GATEADA. El WAF de
// CloudFront del proveedor bloquea la IP de datacenter de la VM (34.30.2.222) con 403.
// ➜ ACTIVAR cuando el admin de theempire.tech allowliste 34.30.2.222: descomentar el
//   import de abajo y su entrada en el arreglo, + deploy. El adapter ya está listo.
// import { DesaparecidosTerremotoAdapter } from './desaparecidos.ts';

// Solo fuentes con scraping REAL: no inyectamos datos sintéticos en producción.
export const adapters: SourceAdapter[] = [
  new VenezuelaTeBuscaAdapter(),       // React Router /_root.data (turbo-stream), trae cédula
  new EstoyAquiAdapter(),              // API JSON /api/datos (buscadas + encontradas), trae cédula
  new DesaparecidosVenezuelaAdapter(), // API JSON /api/personas (sin cédula), trae lat/lng
  new AfectadosAdapter(),              // HTML/SSR multipágina (cédula enmascarada = pista)
  new VenezuelaReportaAdapter(),       // HTML/SSR paginado (sin cédula), UUID por ficha, incremental
  new VzlanosAdapter(),                // API JSON /api/personas paginada (cédula enmascarada = sin merge)
  new StatusVzlaAdapter(),             // Base44 entities (buscadas + encontradas de hospital), sin cédula
  new HospitalesAdapter(),             // FastAPI export pacientes de hospital (localizado), CON cédula
  // new DesaparecidosTerremotoAdapter(), // GATEADA hasta allowlist de IP (ver nota arriba)
];
