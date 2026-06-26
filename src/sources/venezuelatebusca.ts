/**
 * Adaptador para venezuelatebusca.com (React Router SSR).
 *
 * La data viaja en el endpoint de loader `/_root.data` en formato turbo-stream
 * (array plano con referencias por índice). Trae CÉDULA (`idNumber`), así que es
 * una excelente fuente para deduplicar.
 *
 * El sitio ordena por recencia (lo más nuevo primero) y pagina de a 20 con
 * `?page=N`. Cada corrida trae las primeras PAGES_PER_RUN páginas (los reportes
 * más nuevos); cubrir el histórico completo (~30k) sería un backfill aparte.
 */
import type {
  RawRecord, ConditionalReq, RawFetch, Status, SourceConfig,
} from '../types.ts';
import { BaseHttpAdapter, DEFAULT_CONFIG } from './base.ts';

const BASE = 'https://venezuelatebusca.com';
const PAGES_PER_RUN = 8; // 8 × 20 = 160 reportes más nuevos por corrida
const UA = 'vzla-finder/1.0 (agregador solidario de desaparecidos; +https://vzlafinder.reandimo.dev)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Decodifica el array turbo-stream de React Router a su valor real (índice 0). */
export function unflatten(arr: any[]): any {
  const memo = new Map<number, any>();
  const deref = (idx: any): any => {
    if (typeof idx !== 'number') return idx;
    if (idx < 0) return undefined; // huecos/specials de turbo-stream
    if (memo.has(idx)) return memo.get(idx);
    const v = arr[idx];
    let out: any;
    if (Array.isArray(v)) {
      out = []; memo.set(idx, out);
      for (const e of v) out.push(deref(e));
    } else if (v && typeof v === 'object') {
      out = {}; memo.set(idx, out);
      for (const [k, ref] of Object.entries(v)) {
        const key = k.startsWith('_') ? deref(Number(k.slice(1))) : k;
        out[key] = deref(ref);
      }
    } else {
      out = v; memo.set(idx, out);
    }
    return out;
  };
  return deref(0);
}

/** Busca recursivamente el array `persons` dentro del árbol decodificado. */
function findPersons(node: any, depth = 0): any[] | null {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray((node as any).persons)) return (node as any).persons;
  for (const v of Object.values(node)) {
    const r = findPersons(v, depth + 1);
    if (r) return r;
  }
  return null;
}

export class VenezuelaTeBuscaAdapter extends BaseHttpAdapter {
  readonly domain = 'venezuelatebusca.com';
  readonly config: SourceConfig = { ...DEFAULT_CONFIG, intervalMinutes: 60 };

  protected url() {
    return `${BASE}/_root.data`;
  }

  /** Trae varias páginas del loader y las concatena en un solo cuerpo. */
  override async fetchRaw(_cond: ConditionalReq): Promise<RawFetch> {
    const pages: string[] = [];
    for (let p = 1; p <= PAGES_PER_RUN; p++) {
      const res = await fetch(`${BASE}/_root.data?page=${p}`, {
        headers: { 'User-Agent': UA, Accept: 'text/x-script, application/json, */*' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        if (p === 1) throw new Error(`HTTP ${res.status} en ${BASE}/_root.data`);
        break; // una página intermedia que falla no aborta lo ya traído
      }
      pages.push(await res.text());
      if (p < PAGES_PER_RUN) await sleep(this.config.minDelayMs);
    }
    return { notModified: false, body: JSON.stringify(pages), etag: null, lastModified: null };
  }

  parse(body: string): RawRecord[] {
    const pages: string[] = JSON.parse(body);
    const out: RawRecord[] = [];
    const seen = new Set<string>();
    for (const pageText of pages) {
      let arr: any[];
      try { arr = JSON.parse(pageText); } catch { continue; }
      const persons = findPersons(unflatten(arr)) ?? [];
      for (const p of persons) {
        const id = String(p?.id ?? '');
        if (!id || seen.has(id)) continue; // dedup entre páginas solapadas
        seen.add(id);
        out.push(mapPerson(p));
      }
    }
    return out;
  }
}

function mapPerson(p: any): RawRecord {
  const fullName = [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
  const photo = p.photoUrl
    ? (String(p.photoUrl).startsWith('http') ? p.photoUrl : BASE + p.photoUrl)
    : undefined;
  return {
    sourceId: String(p.id),
    sourceUrl: `${BASE}/`,
    fullName,
    cedula: p.idNumber || undefined,
    age: typeof p.age === 'number' ? p.age : undefined,
    gender: p.gender === 'female' ? 'F' : p.gender === 'male' ? 'M' : (p.gender || undefined),
    state: p.state || undefined,
    city: p.city || undefined,
    reference: p.lastSeen || p.description || p.hospitalName || undefined,
    photoUrl: photo,
    status: mapStatus(p.status),
    lastSeenAt: p.lastActivityAt || p.updatedAt || undefined,
    raw: p,
  };
}

function mapStatus(s?: string): Status {
  const v = (s ?? '').toLowerCase();
  if (v.includes('found') || v.includes('localiz') || v.includes('encontr') || v.includes('safe'))
    return 'localizado';
  return 'sin_contacto';
}
