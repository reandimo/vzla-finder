/**
 * Adaptador para desaparecidosterremotovenezuela.com vía su **API oficial de
 * integradores** ("Reconexión", host desaparecidos-terremoto-api.theempire.tech).
 *
 * Antes esta fuente estaba en la lista roja: el sitio público está detrás de
 * reCAPTCHA y no se fuerza (ética del proyecto). Ahora existe una API de SOLO
 * LECTURA con API key por convenio, así que se integra de forma legítima.
 *
 *   GET /api/v1/personas?cursor=&limit=200   (header X-Api-Key)
 *     → { data: Person[], pagination: { nextCursor, hasMore, limit } }
 *
 * Se pagina por CURSOR opaco (reenviar `pagination.nextCursor` en `cursor`) hasta
 * `hasMore=false`. fetchRaw recorre todas las páginas y empaqueta `{ personas }`;
 * parse() mapea cada ficha.
 *
 * ALTO VALOR: trae **cédula ESTRUCTURADA** (`V-12345678`) → clave de merge exacto
 * (cruza esta fuente con los demás silos). `estado` mapea directo:
 *   "sin-contacto" → sin_contacto ; "localizado" → localizado.
 * (El enum de la API no incluye fallecidos, así que no hay nada que excluir; el
 * filtro defensivo de deceso de otras fuentes acá no aplica.)
 *
 * La key se lee de `DESAPARECIDOS_API_KEY` (en /etc/vzla-finder.env). Sin key,
 * fetchRaw lanza error claro (el runner aísla la fuente y sigue con las demás);
 * los tests ejercitan parse() directo con el fixture, sin tocar la red.
 *
 * /centros, /listas e /identificar (facial) NO se ingieren: el valor para reunir
 * familias está en /personas; lo facial/biométrico es sensible y queda fuera.
 */
import type {
  RawRecord, ConditionalReq, RawFetch, Status, SourceConfig,
} from '../types.ts';
import { BaseHttpAdapter, DEFAULT_CONFIG } from './base.ts';

const BASE = 'https://desaparecidos-terremoto-api.theempire.tech/api/v1';
const SITE = 'https://desaparecidosterremotovenezuela.com';
const PAGE_LIMIT = 200;  // máximo que permite la API
const MAX_PAGES = 400;   // tope de seguridad (~80.000 fichas)
const UA = 'vzla-finder/1.0 (agregador solidario de desaparecidos; +https://busquedaunificadavzla.com)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DatosBundle { personas: any[]; }

export class DesaparecidosTerremotoAdapter extends BaseHttpAdapter {
  readonly domain = 'desaparecidosterremotovenezuela.com';
  readonly config: SourceConfig = { ...DEFAULT_CONFIG, intervalMinutes: 60, minDelayMs: 2000 };

  protected url() {
    return `${BASE}/personas`;
  }

  /** Recorre /personas por cursor y empaqueta todas las fichas en un bundle. */
  override async fetchRaw(_cond: ConditionalReq): Promise<RawFetch> {
    const apiKey = process.env.DESAPARECIDOS_API_KEY ?? '';
    if (!apiKey) {
      throw new Error('DESAPARECIDOS_API_KEY no está seteada (requerida para la API de integradores)');
    }
    const personas = await this.fetchAll(apiKey);
    const bundle: DatosBundle = { personas };
    return { notModified: false, body: JSON.stringify(bundle), etag: null, lastModified: null };
  }

  /** Pagina por `nextCursor` hasta agotar `hasMore`, con cortesía y backoff ante 429. */
  private async fetchAll(apiKey: string): Promise<any[]> {
    const all: any[] = [];
    let cursor: string | null = null;
    for (let p = 0; p < MAX_PAGES; p++) {
      const url = new URL(`${BASE}/personas`);
      url.searchParams.set('limit', String(PAGE_LIMIT));
      if (cursor) url.searchParams.set('cursor', cursor);

      const res = await this.getWithRetry(url.toString(), apiKey);
      if (!res.ok) {
        if (p === 0) throw new Error(`HTTP ${res.status} en ${url}`);
        break; // una página intermedia que falla no descarta lo ya traído
      }
      const page: any = await res.json();
      const items: any[] = Array.isArray(page) ? page : (page.data ?? []);
      all.push(...items);

      cursor = page?.pagination?.nextCursor ?? null;
      if (!page?.pagination?.hasMore || !cursor) break; // última página
      await sleep(this.config.minDelayMs);
    }
    return all;
  }

  /** GET con X-Api-Key; reintenta un par de veces ante 429 (rate limit) con backoff. */
  private async getWithRetry(url: string, apiKey: string): Promise<Response> {
    let res!: Response;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json', 'X-Api-Key': apiKey },
        signal: AbortSignal.timeout(25_000),
      });
      if (res.status !== 429) return res;
      await sleep(2000 * (attempt + 1)); // 2s, 4s
    }
    return res;
  }

  parse(body: string): RawRecord[] {
    const data = JSON.parse(body);
    // Tolera el bundle {personas}, una página cruda {data} o un arreglo plano.
    const items: any[] = Array.isArray(data)
      ? data : (data.personas ?? data.data ?? []);
    const out: RawRecord[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const name = strOrUndef(it?.nombre);
      if (!name) continue;
      const id = strOrUndef(it?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const u = it?.ubicacion ?? {};
      const centro = strOrUndef(it?.centro?.nombre);
      const reference = [strOrUndef(it?.descripcion), centro].filter(Boolean).join(' · ')
        || strOrUndef(u?.texto);
      out.push({
        sourceId: id,
        sourceUrl: `${SITE}/`,
        fullName: name,
        cedula: cleanCedula(it?.cedula), // estructurada → clave de merge
        age: numOrUndef(it?.edad),
        gender: undefined,
        state: strOrUndef(u?.estado),
        city: strOrUndef(u?.municipio) ?? strOrUndef(u?.parroquia),
        reference,
        photoUrl: absUrl(it?.foto),
        status: mapStatus(it?.estado),
        lastSeenAt: strOrUndef(it?.fecha) ?? epochToIso(it?.updatedAt),
        raw: it,
      });
    }
    return out;
  }
}

/** "sin-contacto" → sin_contacto ; "localizado" → localizado. */
function mapStatus(s: unknown): Status {
  return String(s ?? '').toLowerCase() === 'localizado' ? 'localizado' : 'sin_contacto';
}

function cleanCedula(c: unknown): string | undefined {
  const v = String(c ?? '').trim();
  return v && v.toLowerCase() !== 'null' ? v : undefined;
}
function epochToIso(ms: unknown): string | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
function absUrl(u: unknown): string | undefined {
  const v = String(u ?? '').trim();
  if (!v || v.toLowerCase() === 'null') return undefined;
  return v.startsWith('http') ? v : undefined; // la API ya da URLs absolutas
}
function numOrUndef(n: unknown): number | undefined {
  return n != null && n !== '' && !Number.isNaN(Number(n)) ? Number(n) : undefined;
}
function strOrUndef(s: unknown): string | undefined {
  const v = String(s ?? '').trim();
  return v && v.toLowerCase() !== 'null' ? v : undefined;
}
