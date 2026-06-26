/**
 * Registro de fuentes. Agregar un silo = crear su adaptador y sumarlo acá.
 * Cada uno declara su propio config (intervalo, cortesía) y su propio parseo.
 */
import type { SourceAdapter } from '../types.ts';
import { VenezuelaTeBuscaAdapter } from './venezuelatebusca.ts';
import { DesaparecidosTerremotoAdapter } from './desaparecidos.ts';

export const adapters: SourceAdapter[] = [
  new VenezuelaTeBuscaAdapter(),          // JSON, trae cédula
  new DesaparecidosTerremotoAdapter(),    // HTML (cheerio)
  // new VenezuelaReportaAdapter(),
  // new TerremotoVenezuelaAdapter(),
];
