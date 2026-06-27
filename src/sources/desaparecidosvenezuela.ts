/**
 * Adaptador para desaparecidosvenezuela.com (Next.js).
 *
 * API JSON pública sin auth:
 *   GET /api/personas  → array de reportes (los 20 MÁS RECIENTES).
 *
 * ⚠️ La API ignora `?page=` y `?limit=`: siempre devuelve los 20 últimos. Como
 * persistimos lo que ingerimos, los vamos acumulando entre corridas (igual que
 * venezuelatebusca). No trae CÉDULA, así que el dedup cae al fallback por silo.
 *
 * Estado: cada reporte tiene `estado` (BUSCADO | INFO_RECIBIDA | ENCONTRADO) y
 * una lista de `actualizaciones`; cuando alguien reporta que la persona apareció
 * llega una actualización con `tipo: 'ENCONTRADO'`. Cualquiera de las dos cosas
 * vale como "la buena noticia".
 *
 * Para volver a modo FIXTURES (offline), poné ENDPOINT = ''.
 */
import { readFileSync } from 'node:fs';
import type {
  RawRecord, ConditionalReq, RawFetch, Status, SourceConfig,
} from '../types.ts';
import { BaseHttpAdapter, politeFetch, DEFAULT_CONFIG } from './base.ts';

const BASE = 'https://www.desaparecidosvenezuela.com';
const ENDPOINT = `${BASE}/api/personas`;

export class DesaparecidosVenezuelaAdapter extends BaseHttpAdapter {
  readonly domain = 'desaparecidosvenezuela.com';
  readonly config: SourceConfig = { ...DEFAULT_CONFIG, intervalMinutes: 30 };

  protected url() {
    return ENDPOINT;
  }

  /** En modo fixtures leemos un archivo local en vez de pegarle a la web. */
  override async fetchRaw(cond: ConditionalReq): Promise<RawFetch> {
    if (!ENDPOINT) {
      const url = new URL('../../fixtures/desaparecidosvenezuela.json', import.meta.url);
      return { notModified: false, body: readFileSync(url, 'utf8'), etag: null, lastModified: null };
    }
    return politeFetch(ENDPOINT, cond, this.config.minDelayMs);
  }

  parse(body: string): RawRecord[] {
    const data = JSON.parse(body);
    const items: any[] = Array.isArray(data)
      ? data
      : (data.items ?? data.personas ?? data.data ?? []);
    const out: RawRecord[] = [];
    for (const it of items) {
      if (it?.oculto === true) continue; // la plataforma lo ocultó: lo respetamos
      if (!String(it?.nombre ?? '').trim()) continue;
      out.push(mapPerson(it));
    }
    return out;
  }
}

/** "Estado · Ciudad · Referencia…" → partes; lo que sobra es la referencia. */
function splitZona(zona: unknown): { state?: string; city?: string; ref?: string } {
  const parts = String(zona ?? '')
    .split('·')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    state: parts[0] || undefined,
    city: parts[1] || undefined,
    ref: parts.slice(2).join(' · ') || undefined,
  };
}

function mapPerson(p: any): RawRecord {
  const { state, city, ref } = splitZona(p.zona);
  const photo = p.fotoUrl
    ? (String(p.fotoUrl).startsWith('http') ? p.fotoUrl : BASE + p.fotoUrl)
    : undefined;
  return {
    sourceId: String(p.id),
    sourceUrl: `${BASE}/p/${p.id}`,
    fullName: String(p.nombre).trim(),
    cedula: undefined, // la fuente no expone cédula
    age: typeof p.edad === 'number' ? p.edad : undefined,
    gender: undefined,
    state,
    city,
    reference: (p.descripcion && String(p.descripcion).trim()) || ref,
    photoUrl: photo,
    status: mapStatus(p),
    lastSeenAt: p.updatedAt || p.createdAt || undefined,
    raw: p,
  };
}

function mapStatus(p: any): Status {
  if (String(p?.estado ?? '').toUpperCase() === 'ENCONTRADO') return 'localizado';
  const acts = Array.isArray(p?.actualizaciones) ? p.actualizaciones : [];
  if (acts.some((a: any) => String(a?.tipo ?? '').toUpperCase() === 'ENCONTRADO'))
    return 'localizado';
  return 'sin_contacto';
}
