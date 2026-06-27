/**
 * Adaptador para venezuelareporta.org (Next.js App Router, SSR).
 *
 * El listado /buscar renderiza ~60 tarjetas por página en DOM real (SSR), así que
 * lo scrapeamos con cheerio. Pagina por `?page=N` (~1.052 páginas, ~63k reportes).
 *
 * ESTRATEGIA INCREMENTAL (como venezuelatebusca): cada corrida trae las
 * PAGES_PER_RUN páginas más nuevas y acumula. El histórico completo (~63k) sería
 * un backfill aparte —no lo hacemos en cada cron para ser corteses y no inflar la
 * DB de golpe—.
 *
 * NO trae cédula → el dedup cae al fallback por silo. Sí trae un ID estable por
 * ficha (UUID en /reporte/<uuid>), que usamos como sourceId.
 */
import { load } from 'cheerio';
import type {
  RawRecord, ConditionalReq, RawFetch, Status, SourceConfig,
} from '../types.ts';
import { BaseHttpAdapter, DEFAULT_CONFIG } from './base.ts';

const BASE = 'https://venezuelareporta.org';
const PAGES_PER_RUN = 10; // 10 × ~60 = ~600 reportes más nuevos por corrida
const UA = 'vzla-finder/1.0 (agregador solidario de desaparecidos; +https://vzlafinder.reandimo.dev)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class VenezuelaReportaAdapter extends BaseHttpAdapter {
  readonly domain = 'venezuelareporta.org';
  readonly config: SourceConfig = { ...DEFAULT_CONFIG, intervalMinutes: 60, minDelayMs: 2000 };

  protected url() {
    return `${BASE}/buscar`;
  }

  /** Trae las primeras PAGES_PER_RUN páginas del listado y las concatena. */
  override async fetchRaw(_cond: ConditionalReq): Promise<RawFetch> {
    const pages: string[] = [];
    for (let p = 1; p <= PAGES_PER_RUN; p++) {
      const res = await fetch(`${BASE}/buscar?page=${p}`, {
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) {
        if (p === 1) throw new Error(`HTTP ${res.status} en ${BASE}/buscar`);
        break; // una página intermedia que falla no aborta lo ya traído
      }
      const html = await res.text();
      pages.push(html);
      if (!html.includes('/reporte/')) break; // se acabaron los resultados
      if (p < PAGES_PER_RUN) await sleep(this.config.minDelayMs);
    }
    return { notModified: false, body: JSON.stringify(pages), etag: null, lastModified: null };
  }

  parse(body: string): RawRecord[] {
    const pages: string[] = JSON.parse(body);
    const out: RawRecord[] = [];
    const seen = new Set<string>();
    for (const html of pages) {
      const $ = load(html);
      $('a[href*="/reporte/"]').each((_, a) => {
        const rec = parseCard($, a, seen);
        if (rec) out.push(rec);
      });
    }
    return out;
  }
}

function parseCard($: any, a: any, seen: Set<string>): RawRecord | null {
  const href = $(a).attr('href') ?? '';
  const id = (href.match(/\/reporte\/([a-z0-9-]+)/i) ?? [])[1];
  if (!id || seen.has(id)) return null; // dedup entre tarjetas/páginas repetidas
  seen.add(id);

  const $a = $(a);
  const name = $a.find('h3').first().text().trim();
  if (!name) return null;

  // Línea meta: "[edad años · ]referencia · estado" (formato variable).
  const meta = $a.find('p').first().text().replace(/\s+/g, ' ').trim();
  const parts = meta.split('·').map((s: string) => s.trim()).filter(Boolean);
  let age: number | undefined;
  const rest: string[] = [];
  for (const part of parts) {
    const m = part.match(/^(\d{1,3})\s*años?$/i);
    if (m && age === undefined) age = Number(m[1]);
    else rest.push(part);
  }

  const badge = $a.find('span.chip').first().text() || meta;
  const photoSrc = $a.find('img').first().attr('src');

  return {
    sourceId: id,
    sourceUrl: BASE + href,
    fullName: name,
    cedula: undefined, // la fuente no expone cédula
    age,
    gender: undefined,
    reference: rest.join(' · ') || undefined,
    photoUrl: photoSrc && /^https?:\/\//i.test(photoSrc) ? photoSrc : undefined,
    status: mapStatus(badge || meta),
    lastSeenAt: undefined,
    raw: { id, name, meta },
  };
}

function mapStatus(s: string): Status {
  if (/encontrad|a salvo|localizad|reunid/i.test(s)) return 'localizado';
  return 'sin_contacto';
}
