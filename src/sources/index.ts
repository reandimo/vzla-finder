/**
 * Registro de fuentes. Agregar un silo = crear su adaptador y sumarlo acá.
 * Cada uno declara su propio config (intervalo, cortesía) y su propio parseo.
 */
import type { SourceAdapter } from '../types.ts';
import { VenezuelaTeBuscaAdapter } from './venezuelatebusca.ts';
import { EstoyAquiAdapter } from './estoyaqui.ts';

// Solo fuentes con scraping REAL: no inyectamos datos sintéticos en producción.
//
// desaparecidos.ts NO se incluye: su API exige verificación reCAPTCHA, así que
// no es scrapeable por automatización (respetamos su protección). El adaptador
// y su fixture quedan para los tests. venezuelareporta.org (API Supabase) es la
// próxima candidata a sumar.
export const adapters: SourceAdapter[] = [
  new VenezuelaTeBuscaAdapter(),   // React Router /_root.data (turbo-stream), trae cédula
  new EstoyAquiAdapter(),          // API JSON /api/encontradas, trae cédula
];
