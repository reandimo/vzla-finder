/**
 * Adaptador HTML para desaparecidosterremotovenezuela.com.
 *
 * Demuestra que el PARSEO difiere por fuente: acá no hay JSON, scrapeamos el
 * listado con cheerio. El fetch (cortesía, ETag, throttle) lo hereda igual de
 * BaseHttpAdapter — esa parte no se reescribe.
 *
 * ⚠️ Los selectores de abajo son de ejemplo. Ajustalos a la estructura real
 * del sitio (F12 → Elements). Si la lista se carga por JS y no viene en el HTML
 * inicial, hay dos caminos: (a) buscar el endpoint JSON que la alimenta y usar
 * un adaptador JSON, o (b) renderizar con Playwright. Preferí (a) siempre.
 */
import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import type {
  RawRecord, ConditionalReq, RawFetch, Status, SourceConfig,
} from '../types.ts';
import { BaseHttpAdapter, politeFetch, DEFAULT_CONFIG } from './base.ts';

const ENDPOINT = ''; // ← URL del listado HTML real cuando la conectes

export class DesaparecidosTerremotoAdapter extends BaseHttpAdapter {
  readonly domain = 'desaparecidosterremotovenezuela.com';
  // Sitio HTML, un poco más pesado → un poco más de demora entre hits.
  readonly config: SourceConfig = { ...DEFAULT_CONFIG, intervalMinutes: 15, minDelayMs: 2500 };

  protected url() {
    return ENDPOINT;
  }

  override async fetchRaw(cond: ConditionalReq): Promise<RawFetch> {
    if (!ENDPOINT) {
      const url = new URL('../../fixtures/desaparecidos-terremoto.html', import.meta.url);
      return { notModified: false, body: readFileSync(url, 'utf8'), etag: null, lastModified: null };
    }
    return politeFetch(ENDPOINT, cond, this.config.minDelayMs);
  }

  parse(html: string): RawRecord[] {
    const $ = load(html);
    const out: RawRecord[] = [];

    $('li.persona').each((_, el) => {
      const $el = $(el);
      const id = $el.attr('data-id') ?? '';
      const href = $el.find('a.ficha').attr('href') ?? '';
      const ubic = $el.find('.ubicacion').text().trim();
      const [state, city] = ubic.split('/').map((s) => s.trim());
      const cedula = $el.find('.cedula').text().trim();
      const edad = $el.find('.edad').text().trim();

      out.push({
        sourceId: id,
        sourceUrl: href ? `https://${this.domain}${href}` : undefined,
        fullName: $el.find('.nombre').text().trim(),
        cedula: cedula || undefined,
        age: edad ? Number(edad) : undefined,
        state: state || undefined,
        city: city || undefined,
        status: mapStatus($el.attr('data-estatus')),
        raw: { id },
      });
    });

    return out;
  }
}

function mapStatus(s?: string): Status {
  const v = (s ?? '').toLowerCase();
  if (v.includes('localiz') || v.includes('encontr')) return 'localizado';
  return 'sin_contacto';
}
