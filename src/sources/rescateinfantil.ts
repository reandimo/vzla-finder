/**
 * Adaptador para Rescate Infantil Venezuela (rescateinfantilvenezuela.com) —
 * registro de NIÑOS (NNA) tras el terremoto: tanto reportados como desaparecidos
 * como rescatados/en custodia a la espera de identificar a su familia.
 *
 * API JSON propia (sin captcha):
 *   GET /api/search?q=&page=N&limit=100   → { data: Nino[], total, totalPages }
 *   Con `q` VACÍO devuelve el padrón completo paginado → enumerable en bulk.
 *
 * CON cédula del niño (`cedula`, ~11% — clave de merge exacto cuando está). El
 * nombre se compone de firstName + secondName + lastName. `findLocation{state,
 * municipality}` ubica; `currentLocation.hospital` es dónde está ahora (a veces
 * vacío). `caseStatus` → LISTA BLANCA (con menores, un falso "está a salvo" es el
 * peor error, así que nunca damos "hallado" por defecto):
 *   HOSPITALIZED/REUNIFIED/TRANSFERRED/IDENTIFIED/DISCHARGED/RESCUED/SAFE/FOUND
 *     → localizado (confirmado hallado/en custodia).
 *   MISSING, UNIDENTIFIED y PARTIAL_IDENTITY → sin_contacto (aún sin ubicar o sin
 *     confirmar quién es; no afirmamos hallazgo). CUALQUIER valor desconocido/nuevo
 *     cae acá también. El enum no tiene estado de deceso.
 *
 * ⚠️ DATOS DE MENORES + la API filtra PII de registro de más
 * (registrationIp/Ua/Gps, y datos del RESCATISTA: rescuerCedula/rescuerPhone/
 * rescuerWhatsapp). Mapeamos SOLO lo mínimo y público del niño; `raw` va redactado
 * (nada de IPs ni contacto del rescatista). La `cedula` es la del NIÑO, no la del
 * rescatista.
 *
 * Para volver a modo FIXTURES (offline), poné BASE = ''.
 */
import { readFileSync } from 'node:fs';
import type {
  RawRecord, ConditionalReq, RawFetch, Status, SourceConfig,
} from '../types.ts';
import { BaseHttpAdapter, DEFAULT_CONFIG } from './base.ts';

const BASE = 'https://rescateinfantilvenezuela.com';
const PAGE_LIMIT = 100;
const MAX_PAGES = 50; // tope de seguridad (~5.000)
const UA = 'vzla-finder/1.0 (agregador solidario de desaparecidos; +https://busquedaunificadavzla.com)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DatosBundle { ninos: any[]; }

export class RescateInfantilAdapter extends BaseHttpAdapter {
  readonly domain = 'rescateinfantilvenezuela.com';
  readonly config: SourceConfig = { ...DEFAULT_CONFIG, intervalMinutes: 60, minDelayMs: 2000 };

  protected url() {
    return `${BASE}/api/search`;
  }

  /** Pagina con q='' (lista todo) hasta agotar `totalPages` y empaqueta el bundle. */
  override async fetchRaw(_cond: ConditionalReq): Promise<RawFetch> {
    if (!BASE) {
      const url = new URL('../../fixtures/rescateinfantil.json', import.meta.url);
      return { notModified: false, body: readFileSync(url, 'utf8'), etag: null, lastModified: null };
    }
    const ninos = await this.fetchAll();
    const bundle: DatosBundle = { ninos };
    return { notModified: false, body: JSON.stringify(bundle), etag: null, lastModified: null };
  }

  private async fetchAll(): Promise<any[]> {
    const all: any[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${BASE}/api/search?q=&page=${page}&limit=${PAGE_LIMIT}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) {
        if (page === 1) throw new Error(`HTTP ${res.status} en ${url}`);
        break;
      }
      const body: any = await res.json();
      const items: any[] = body?.data ?? (Array.isArray(body) ? body : []);
      all.push(...items);
      const totalPages = Number(body?.totalPages ?? 1);
      if (items.length < PAGE_LIMIT || page >= totalPages) break;
      await sleep(this.config.minDelayMs);
    }
    return all;
  }

  parse(body: string): RawRecord[] {
    const data = JSON.parse(body);
    const items: any[] = Array.isArray(data)
      ? data : (data.ninos ?? data.data ?? []);
    const out: RawRecord[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const name = composeName(it);
      if (!name) continue;
      if (isFallecido(it?.caseStatus) || isFallecido(it?.observations)) continue; // nunca "a salvo"
      const id = strOrUndef(it?.id) ?? strOrUndef(it?.code);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const find = it?.findLocation ?? {};
      const hospital = strOrUndef(it?.currentLocation?.hospital);
      const reference = [hospital, strOrUndef(it?.observations)].filter(Boolean).join(' · ') || undefined;
      out.push({
        sourceId: id,
        sourceUrl: `${BASE}/`,
        fullName: name,
        cedula: cleanCedula(it?.cedula), // cédula del NIÑO (no la del rescatista)
        age: numOrUndef(it?.approximateAge),
        gender: mapSex(it?.sex),
        state: strOrUndef(find?.state),
        city: strOrUndef(find?.municipality),
        reference,
        photoUrl: mainPhoto(it?.photos),
        status: mapStatus(it?.caseStatus),
        lastSeenAt: strOrUndef(it?.rescuedAt) ?? strOrUndef(it?.createdAt),
        raw: { id, code: it?.code, caseStatus: it?.caseStatus }, // redactado: sin PII de registro/rescatista
      });
    }
    return out;
  }
}

/**
 * LISTA BLANCA: solo estados que CONFIRMAN al niño hallado/en custodia → localizado.
 * MISSING, UNIDENTIFIED, PARTIAL_IDENTITY y cualquier valor desconocido/nuevo →
 * sin_contacto. Con menores nunca se afirma "a salvo" por defecto (evita el patrón
 * de falsa esperanza del padrón hospitalario). Los fallecidos ya se filtran antes.
 */
const LOCATED_STATES = new Set([
  'HOSPITALIZED', 'REUNIFIED', 'TRANSFERRED', 'IDENTIFIED', 'DISCHARGED', 'RESCUED', 'SAFE', 'FOUND',
]);
function mapStatus(s: unknown): Status {
  return LOCATED_STATES.has(String(s ?? '').toUpperCase().trim()) ? 'localizado' : 'sin_contacto';
}

function composeName(it: any): string | undefined {
  const parts = [it?.firstName, it?.secondName, it?.lastName]
    .map((p) => String(p ?? '').trim()).filter(Boolean);
  const name = parts.join(' ').replace(/\s+/g, ' ').trim();
  return name || undefined;
}

function mapSex(s: unknown): string | undefined {
  const v = String(s ?? '').toUpperCase();
  return v === 'FEMALE' ? 'F' : v === 'MALE' ? 'M' : undefined;
}

/** Toma la foto principal (objeto o arreglo) y la vuelve absoluta. */
function mainPhoto(photos: unknown): string | undefined {
  if (!photos) return undefined;
  const p = Array.isArray(photos)
    ? (photos.find((x: any) => x?.isMain) ?? photos[0]) : photos as any;
  const u = String(p?.url ?? '').trim();
  if (!u || u.toLowerCase() === 'null') return undefined;
  return u.startsWith('http') ? u : BASE + (u.startsWith('/') ? u : '/' + u);
}

function isFallecido(s: unknown): boolean {
  return /fallec|muert|deces|occiso|sin[_ ]?vida/.test(String(s ?? '').toLowerCase());
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
  return v && v.toLowerCase() !== 'null' ? v : undefined;
}
