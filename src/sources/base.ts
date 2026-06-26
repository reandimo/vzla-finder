/**
 * Núcleo de traída compartido. Acá vive todo lo que NO debe diferir entre
 * fuentes: cortesía (throttle por host), requests condicionales (ETag /
 * Last-Modified), timeout y User-Agent identificable.
 *
 * Lo que SÍ difiere por fuente —la URL y el parseo— queda en cada adaptador.
 */
import type {
  SourceAdapter,
  SourceConfig,
  ConditionalReq,
  RawFetch,
  RawRecord,
} from '../types.ts';

const USER_AGENT =
  'vzla-finder/1.0 (agregador solidario de desaparecidos; +https://vzlafinder.reandimo.dev)';

export const DEFAULT_CONFIG: SourceConfig = {
  intervalMinutes: 15,
  minDelayMs: 1500,
  jitterMs: 30_000,
};

/** Último request por host, para respetar minDelayMs entre llamadas. */
const lastHit = new Map<string, number>();

async function throttle(host: string, minDelayMs: number) {
  const prev = lastHit.get(host) ?? 0;
  const wait = prev + minDelayMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

/**
 * GET cortés con request condicional. Devuelve notModified=true ante 304,
 * así no re-descargamos ni re-procesamos lo que no cambió.
 */
export async function politeFetch(
  url: string,
  cond: ConditionalReq,
  minDelayMs: number,
): Promise<RawFetch> {
  const host = new URL(url).host;
  await throttle(host, minDelayMs);

  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/html;q=0.9,*/*;q=0.8',
  };
  if (cond.etag) headers['If-None-Match'] = cond.etag;
  if (cond.lastModified) headers['If-Modified-Since'] = cond.lastModified;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });

  if (res.status === 304) {
    return { notModified: true, body: null, etag: cond.etag, lastModified: cond.lastModified };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);

  return {
    notModified: false,
    body: await res.text(),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

/**
 * Clase base para fuentes que se traen con un simple GET (JSON o HTML).
 * El adaptador concreto solo define url() y parse(). Para casos raros
 * (API con POST/token, paginación), un adaptador puede implementar
 * SourceAdapter a mano sin extender esto.
 */
export abstract class BaseHttpAdapter implements SourceAdapter {
  abstract readonly domain: string;
  readonly config: SourceConfig = DEFAULT_CONFIG;

  /** URL primaria a traer. */
  protected abstract url(): string;
  /** Parseo específico de la fuente. */
  abstract parse(body: string): RawRecord[];

  async fetchRaw(cond: ConditionalReq): Promise<RawFetch> {
    return politeFetch(this.url(), cond, this.config.minDelayMs);
  }
}
