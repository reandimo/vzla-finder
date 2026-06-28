/**
 * Adaptador para Status Vzla (statusvzla.com) — plataforma ciudadana del terremoto
 * construida sobre Base44 (backend no-code). Expone una API REST de entidades
 * PÚBLICA (sin auth, sin captcha):
 *   GET /api/apps/<APP_ID>/entities/PersonasBuscadas?limit=&skip=&sort=-updated_date
 *   GET /api/apps/<APP_ID>/entities/PersonasEncontradas?limit=&skip=&sort=-updated_date
 *     → arreglo plano de entidades (no envoltorio). Pagina por `skip`.
 *
 *  - PersonasBuscadas    → desaparecidos (estado_caso "buscando")  → sin_contacto
 *  - PersonasEncontradas → HALLADOS en hospitales/refugios          → localizado
 *
 * El valor real de esta fuente está en PersonasEncontradas: son listas (muchas
 * `subida_masiva_institucional`, de hospitales) de gente encontrada con vida —
 * justo lo que reúne familias. `condicion`: a_salvo / herido_leve / herido_grave /
 * no_identificado. El nombre de un encontrado vive en `nombre_o_descripcion` (a
 * veces es una descripción física cuando aún no se identifica a la persona).
 *
 * ⚠️ FALLECIDOS: si `condicion` indica deceso, se EXCLUYE. Marcar a un fallecido
 * como "a salvo/localizado" sería falso e hiriente (mismo criterio que
 * estoyaqui.ts / afectados.ts). En las muestras no aparecen, pero el filtro queda
 * por si la fuente sube esa condición a futuro.
 *
 * NO trae cédula en ninguna entidad → el dedup cae al fallback por silo (sin merge
 * exacto). Los teléfonos/emails de contacto NO se re-hostean (se enlaza a la
 * fuente). `is_sample: true` = registro de demo de Base44 → se descarta.
 *
 * Para volver a modo FIXTURES (offline), poné BASE = ''.
 */
import { readFileSync } from 'node:fs';
import type {
  RawRecord, ConditionalReq, RawFetch, Status, SourceConfig,
} from '../types.ts';
import { BaseHttpAdapter, DEFAULT_CONFIG } from './base.ts';

const BASE = 'https://statusvzla.com';
const APP_ID = '6a3ddf29c9e933d4c38e9646';
const ENTITIES = `${BASE}/api/apps/${APP_ID}/entities`;
const PAGE_LIMIT = 500; // máximo cómodo por request
const MAX_PAGES = 12;   // tope de seguridad (~6.000 por entidad)
const UA = 'vzla-finder/1.0 (agregador solidario de desaparecidos; +https://busquedaunificadavzla.com)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DatosBundle { buscadas: any[]; encontradas: any[]; }

export class StatusVzlaAdapter extends BaseHttpAdapter {
  readonly domain = 'statusvzla.com';
  readonly config: SourceConfig = { ...DEFAULT_CONFIG, intervalMinutes: 60, minDelayMs: 2000 };

  protected url() {
    return `${ENTITIES}/PersonasBuscadas`;
  }

  /** Pagina ambas entidades por `skip` y empaqueta todo en un bundle. */
  override async fetchRaw(_cond: ConditionalReq): Promise<RawFetch> {
    if (!BASE) {
      const url = new URL('../../fixtures/statusvzla.json', import.meta.url);
      return { notModified: false, body: readFileSync(url, 'utf8'), etag: null, lastModified: null };
    }
    const buscadas = await this.fetchEntity('PersonasBuscadas');
    const encontradas = await this.fetchEntity('PersonasEncontradas');
    const bundle: DatosBundle = { buscadas, encontradas };
    return { notModified: false, body: JSON.stringify(bundle), etag: null, lastModified: null };
  }

  /** Trae una entidad completa paginando por `skip` hasta agotar páginas. */
  private async fetchEntity(entity: string): Promise<any[]> {
    const all: any[] = [];
    for (let p = 0; p < MAX_PAGES; p++) {
      const url = `${ENTITIES}/${entity}?limit=${PAGE_LIMIT}&skip=${p * PAGE_LIMIT}&sort=-updated_date`;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${BASE}/personas` },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) {
        if (p === 0) throw new Error(`HTTP ${res.status} en ${ENTITIES}/${entity}`);
        break; // una página intermedia que falla no aborta lo ya traído
      }
      const data: any = await res.json();
      const items: any[] = Array.isArray(data) ? data : (data.items ?? []);
      all.push(...items);
      if (items.length < PAGE_LIMIT) break; // última página
      await sleep(this.config.minDelayMs);
    }
    return all;
  }

  parse(body: string): RawRecord[] {
    const data = JSON.parse(body);
    const bundle: DatosBundle = Array.isArray(data)
      ? { buscadas: data, encontradas: [] } // tolera un arreglo plano de buscadas
      : { buscadas: data.buscadas ?? [], encontradas: data.encontradas ?? [] };
    const out: RawRecord[] = [];
    const seen = new Set<string>();
    for (const it of bundle.buscadas) {
      const rec = mapBuscada(it);
      if (rec && !seen.has(rec.sourceId)) { seen.add(rec.sourceId); out.push(rec); }
    }
    for (const it of bundle.encontradas) {
      const rec = mapEncontrada(it);
      if (rec && !seen.has(rec.sourceId)) { seen.add(rec.sourceId); out.push(rec); }
    }
    return out;
  }
}

/** Persona BUSCADA → sin_contacto (salvo que la fuente ya la marque hallada). */
function mapBuscada(it: any): RawRecord | null {
  if (it?.is_sample) return null;
  const name = strOrUndef(it?.nombre_completo);
  if (!name) return null;
  const caso = String(it?.estado_caso ?? '').toLowerCase();
  const status: Status = /encontrad|localiz|hallad|a[_ ]?salvo/.test(caso) ? 'localizado' : 'sin_contacto';
  return {
    sourceId: String(it.id),
    sourceUrl: `${BASE}/personas`,
    fullName: name,
    cedula: undefined, // la fuente no expone cédula → sin merge exacto
    age: numOrUndef(it.edad_aprox),
    gender: strOrUndef(it.sexo),
    state: strOrUndef(it.estado_region),
    city: strOrUndef(it.ciudad),
    reference: strOrUndef(it.ultima_ubicacion_conocida) ?? strOrUndef(it.descripcion_fisica),
    photoUrl: absUrl(it.foto_url) ?? absUrl(it.foto_url_2),
    status,
    lastSeenAt: strOrUndef(it.fecha_ultima_vez) ?? strOrUndef(it.created_date),
    raw: it,
  };
}

/** Persona ENCONTRADA (hospital/refugio) → localizado. Fallecido se excluye. */
function mapEncontrada(it: any): RawRecord | null {
  if (it?.is_sample) return null;
  const name = strOrUndef(it?.nombre_o_descripcion);
  if (!name) return null;
  if (isFallecido(it?.condicion)) return null; // nunca "a salvo"
  // Dónde fue hallada es la pista clave para la familia (hospital/refugio).
  const dondeHallada = strOrUndef(it.ubicacion_actual) ?? strOrUndef(it.nombre_lugar)
    ?? strOrUndef(it.descripcion_fisica);
  return {
    sourceId: String(it.id),
    sourceUrl: `${BASE}/personas`,
    fullName: name,
    cedula: undefined,
    age: numOrUndef(it.edad_aprox),
    gender: strOrUndef(it.sexo),
    state: strOrUndef(it.estado_region),
    city: strOrUndef(it.ciudad),
    reference: dondeHallada,
    photoUrl: absUrl(it.foto_url) ?? absUrl(it.foto_url_2),
    status: 'localizado',
    lastSeenAt: strOrUndef(it.created_date),
    raw: it,
  };
}

/** ¿La condición del hallazgo indica deceso? (defensivo: hoy no aparece) */
function isFallecido(cond: unknown): boolean {
  return /fallec|muert|deces|cadav|sin[_ ]?vida|occiso/.test(String(cond ?? '').toLowerCase());
}

function absUrl(u: unknown): string | undefined {
  const v = String(u ?? '').trim();
  if (!v || v.toLowerCase() === 'null') return undefined;
  return v.startsWith('http') ? v : BASE + (v.startsWith('/') ? v : '/' + v);
}
function numOrUndef(n: unknown): number | undefined {
  return n != null && n !== '' && !Number.isNaN(Number(n)) ? Number(n) : undefined;
}
function strOrUndef(s: unknown): string | undefined {
  const v = String(s ?? '').trim();
  return v && v.toLowerCase() !== 'null' ? v : undefined;
}
