/**
 * Adaptador para vzlanos.com (hecha por arizon.ai), plataforma ciudadana de
 * desaparecidos del terremoto, enfocada en La Guaira.
 *
 * API JSON pública (sin auth; el reCAPTCHA del front NO se exige en la API):
 *   GET /api/personas?page=N&pageSize=100&estado=todos
 *     → { items:[...], total, page, pageSize, totalPages, counts }
 *
 * estado por persona: "sin-contacto" → sin_contacto · "localizado" → localizado.
 * NO trae cédula utilizable (el buscador la muestra ENMASCARADA) → el dedup cae al
 * fallback por silo. `foto` viene como ruta relativa /api/reports/<id>/photo.
 * `contacto` es el teléfono del reportante: NO se re-hostea (se enlaza a la fuente).
 *
 * Para volver a modo FIXTURES (offline), poné BASE = ''.
 */
import { readFileSync } from 'node:fs';
import type {
  RawRecord, ConditionalReq, RawFetch, Status, SourceConfig,
} from '../types.ts';
import { BaseHttpAdapter, DEFAULT_CONFIG } from './base.ts';

const BASE = 'https://vzlanos.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 20; // tope de seguridad (~2.000)
const UA = 'vzla-finder/1.0 (agregador solidario de desaparecidos; +https://busquedaunificadavzla.com)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class VzlanosAdapter extends BaseHttpAdapter {
  readonly domain = 'vzlanos.com';
  readonly config: SourceConfig = { ...DEFAULT_CONFIG, intervalMinutes: 30, minDelayMs: 2000 };

  protected url() {
    return `${BASE}/api/personas?page=1&pageSize=${PAGE_SIZE}&estado=todos`;
  }

  /** Pagina /api/personas hasta totalPages y empaqueta todos los items. */
  override async fetchRaw(_cond: ConditionalReq): Promise<RawFetch> {
    if (!BASE) {
      const url = new URL('../../fixtures/vzlanos.json', import.meta.url);
      return { notModified: false, body: readFileSync(url, 'utf8'), etag: null, lastModified: null };
    }
    const all: any[] = [];
    let totalPages = 1;
    for (let p = 1; p <= MAX_PAGES; p++) {
      const res = await fetch(`${BASE}/api/personas?page=${p}&pageSize=${PAGE_SIZE}&estado=todos`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) {
        if (p === 1) throw new Error(`HTTP ${res.status} en ${BASE}/api/personas`);
        break; // una página intermedia que falla no aborta lo ya traído
      }
      const data: any = await res.json();
      const items: any[] = data.items ?? [];
      all.push(...items);
      if (p === 1) totalPages = Math.min(MAX_PAGES, Math.max(1, Number(data.totalPages ?? 1)));
      if (p >= totalPages || items.length === 0) break;
      await sleep(this.config.minDelayMs);
    }
    return { notModified: false, body: JSON.stringify(all), etag: null, lastModified: null };
  }

  parse(body: string): RawRecord[] {
    const data = JSON.parse(body);
    const items: any[] = Array.isArray(data) ? data : (data.items ?? []);
    const out: RawRecord[] = [];
    for (const it of items) {
      const name = String(it?.nombre ?? '').trim();
      if (!name) continue;
      const foto = it.foto ? String(it.foto) : '';
      const photoUrl = foto ? (foto.startsWith('http') ? foto : BASE + foto) : undefined;
      out.push({
        sourceId: String(it.id),
        sourceUrl: `${BASE}/desaparecidos`,
        fullName: name,
        cedula: undefined, // la API enmascara la cédula → no es clave de merge
        age: it.edad != null && !Number.isNaN(Number(it.edad)) ? Number(it.edad) : undefined,
        gender: undefined,
        reference: String(it.ubicacion ?? it.descripcion ?? '').trim() || undefined,
        photoUrl,
        status: mapStatus(it.estado),
        lastSeenAt: strOrUndef(it.fecha) ?? strOrUndef(it.createdAt),
        raw: it,
      });
    }
    return out;
  }
}

function mapStatus(s: unknown): Status {
  const v = String(s ?? '').toLowerCase();
  if (v.includes('localizado') || v.includes('encontrad') || v.includes('salvo')) return 'localizado';
  return 'sin_contacto';
}
function strOrUndef(s: unknown): string | undefined {
  const v = String(s ?? '').trim();
  return v || undefined;
}
