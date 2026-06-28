/**
 * Adaptador para "Estoy Aquí Venezuela" / FindUsers Vzla (estoyaquive.up.railway.app).
 * Plataforma ciudadana de desaparecidos del terremoto (FastAPI). Trae CÉDULA.
 *
 * Consumimos el export COMPLETO del dataset (API oficial):
 *   GET /api/datos?limit=&offset=
 *     → { totales, personas_buscadas[], personas_encontradas[], matches[], posts[], ... }
 *   - `limit` = registros POR TABLA (1–500). `totales` sirve para paginar.
 *   - personas_buscadas    → desaparecidos (estado "buscando")  → sin_contacto
 *   - personas_encontradas → hallados (estado_salud)            → localizado
 *
 * Antes solo consumíamos /api/encontradas (los hallados). Con /api/datos sumamos
 * también las personas BUSCADAS —justo lo que un buscador de desaparecidos
 * necesita—. Ambas tablas pueden traer cédula → merge exacto entre plataformas.
 *
 * ⚠️ FALLECIDOS: `estado_salud: 'fallecido'` se EXCLUYE. El modelo no representa la
 * muerte y marcar a un fallecido como "a salvo" sería falso e hiriente (mismo
 * criterio que afectados.ts). Cualquier otro estado de salud = hallado con vida.
 *
 * sourceId: cada tabla tiene su propia secuencia de `id`. Las ENCONTRADAS conservan
 * el id numérico (continuidad con el scrape histórico de /api/encontradas); las
 * BUSCADAS se prefijan con "b-" para no colisionar con una encontrada del mismo id.
 *
 * Solo personas: matches/posts/mascotas de /api/datos se ignoran.
 * Para volver a modo FIXTURES (offline), poné ENDPOINT = ''.
 */
import { readFileSync } from 'node:fs';
import type {
  RawRecord, ConditionalReq, RawFetch, Status, SourceConfig,
} from '../types.ts';
import { BaseHttpAdapter, DEFAULT_CONFIG } from './base.ts';

const BASE = 'https://estoyaquive.up.railway.app';
const ENDPOINT = `${BASE}/api/datos`;
const PAGE_LIMIT = 500; // máximo por tabla que admite la API
const MAX_PAGES = 12;   // tope de seguridad (~6.000 por tabla)
const UA = 'vzla-finder/1.0 (agregador solidario de desaparecidos; +https://busquedaunificadavzla.com)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DatosPage { personas_buscadas: any[]; personas_encontradas: any[]; }

export class EstoyAquiAdapter extends BaseHttpAdapter {
  readonly domain = 'estoyaquive.up.railway.app';
  readonly config: SourceConfig = { ...DEFAULT_CONFIG, intervalMinutes: 60, minDelayMs: 2000 };

  protected url() {
    return ENDPOINT;
  }

  /** Pagina /api/datos por `offset` hasta cubrir la tabla más grande. */
  override async fetchRaw(_cond: ConditionalReq): Promise<RawFetch> {
    if (!ENDPOINT) {
      const url = new URL('../../fixtures/estoyaqui.json', import.meta.url);
      return { notModified: false, body: readFileSync(url, 'utf8'), etag: null, lastModified: null };
    }
    const pages: DatosPage[] = [];
    let totalPages = 1;
    for (let p = 0; p < MAX_PAGES; p++) {
      const res = await fetch(`${ENDPOINT}?limit=${PAGE_LIMIT}&offset=${p * PAGE_LIMIT}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) {
        if (p === 0) throw new Error(`HTTP ${res.status} en ${ENDPOINT}`);
        break; // una página intermedia que falla no aborta lo ya traído
      }
      const data: any = await res.json();
      pages.push({
        personas_buscadas: data.personas_buscadas ?? [],
        personas_encontradas: data.personas_encontradas ?? [],
      });
      if (p === 0) {
        const t = data.totales ?? {};
        const maxRows = Math.max(Number(t.personas_buscadas ?? 0), Number(t.personas_encontradas ?? 0));
        totalPages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(maxRows / PAGE_LIMIT)));
      }
      if (p + 1 >= totalPages) break;
      await sleep(this.config.minDelayMs);
    }
    return { notModified: false, body: JSON.stringify(pages), etag: null, lastModified: null };
  }

  parse(body: string): RawRecord[] {
    const data = JSON.parse(body);
    const pages: DatosPage[] = Array.isArray(data) ? data : [data];
    const out: RawRecord[] = [];
    const seen = new Set<string>();
    for (const pg of pages) {
      for (const it of pg?.personas_buscadas ?? []) {
        const rec = mapBuscada(it);
        if (rec && !seen.has(rec.sourceId)) { seen.add(rec.sourceId); out.push(rec); }
      }
      for (const it of pg?.personas_encontradas ?? []) {
        const rec = mapEncontrada(it);
        if (rec && !seen.has(rec.sourceId)) { seen.add(rec.sourceId); out.push(rec); }
      }
    }
    return out;
  }
}

/** Persona BUSCADA → sin_contacto (salvo que la fuente la marque ya hallada). */
function mapBuscada(it: any): RawRecord | null {
  const name = String(it?.nombre_completo ?? '').trim();
  if (!name) return null;
  const estado = String(it?.estado ?? '').toLowerCase();
  const status: Status = /encontrad|localiz|hallad/.test(estado) ? 'localizado' : 'sin_contacto';
  return {
    sourceId: `b-${it.id}`,
    sourceUrl: `${BASE}/`,
    fullName: name,
    cedula: cleanCedula(it.cedula),
    age: numOrUndef(it.edad),
    gender: undefined,
    reference: strOrUndef(it.ultima_ubicacion),
    photoUrl: undefined, // foto_filename: la API no documenta URL de servido (hoy null)
    status,
    lastSeenAt: strOrUndef(it.fecha_reporte),
    raw: it,
  };
}

/** Persona ENCONTRADA → localizado (la buena noticia). Fallecido se excluye. */
function mapEncontrada(it: any): RawRecord | null {
  const name = String(it?.nombre_completo ?? '').trim();
  if (!name) return null;
  if (String(it?.estado_salud ?? '').toLowerCase() === 'fallecido') return null; // nunca "a salvo"
  return {
    sourceId: String(it.id),
    sourceUrl: `${BASE}/`,
    fullName: name,
    cedula: cleanCedula(it.cedula),
    age: numOrUndef(it.edad_aproximada),
    gender: undefined,
    reference: strOrUndef(it.ubicacion_actual) ?? strOrUndef(it.descripcion_fisica),
    photoUrl: undefined,
    status: 'localizado',
    lastSeenAt: strOrUndef(it.fecha_reporte),
    raw: it,
  };
}

function cleanCedula(c: unknown): string | undefined {
  const v = String(c ?? '').trim();
  return v && v.toLowerCase() !== 'null' ? v : undefined;
}
function numOrUndef(n: unknown): number | undefined {
  return n != null && n !== '' && !Number.isNaN(Number(n)) ? Number(n) : undefined;
}
function strOrUndef(s: unknown): string | undefined {
  const v = String(s ?? '').trim();
  return v || undefined;
}
