/**
 * Adaptador para el registro hospitalario "Búsqueda de Personas — Venezuela junio
 * 2026" (FastAPI/uvicorn en http://62.146.225.76:9090). Padrón MIXTO: gente atendida
 * en hospitales/refugios (hallada con vida → localizado) PERO también casos que el
 * propio padrón sigue buscando ("En Búsqueda" / "Por confirmar" → sin_contacto).
 *
 * API pública (sin auth, sin captcha). Usamos el export completo (1 request cortés):
 *   GET /public/descargar/pacientes.json  → { total, results:[...] }
 *   (también existe /public/pacientes?page=&limit=&q=&estado=&hospital_id= paginado)
 *
 * Cada paciente: { id, nombre_completo, cedula, estado (estado clínico), edad,
 *   sector (barrio de origen), hospital, processed_at }.
 *
 * CÉDULA ESTRUCTURADA (no enmascarada): ~44% la traen → clave de merge exacto. Que
 * un hospitalizado con cédula cruce con su reporte de "buscado" es justo la reunión
 * que perseguimos ("tu familiar está en el Hospital Vargas").
 *
 * ⚠️ FALLECIDOS: `estado` "Fallecido"/"FALLECIDO" se EXCLUYE — marcar a un fallecido
 * como "a salvo" sería falso e hiriente (mismo criterio que estoyaqui/afectados/
 * statusvzla). ⚠️ "En Búsqueda"/"Por confirmar" NO son "a salvo": siguen desaparecidos
 * → sin_contacto. El resto (Hospitalizado, Refugiado, De Alta, Traslado…) = hallado.
 *
 * Referencia = hospital donde está + sector de origen (lo que ubica a la persona).
 *
 * Para volver a modo FIXTURES (offline), poné BASE = ''.
 */
import { readFileSync } from 'node:fs';
import type {
  RawRecord, ConditionalReq, RawFetch, SourceConfig, Status,
} from '../types.ts';
import { BaseHttpAdapter, DEFAULT_CONFIG } from './base.ts';

const BASE = 'http://62.146.225.76:9090';
const EXPORT = `${BASE}/public/descargar/pacientes.json`;
const UA = 'vzla-finder/1.0 (agregador solidario de desaparecidos; +https://busquedaunificadavzla.com)';

export class HospitalesAdapter extends BaseHttpAdapter {
  readonly domain = '62.146.225.76:9090';
  readonly config: SourceConfig = { ...DEFAULT_CONFIG, intervalMinutes: 60, minDelayMs: 2000 };

  protected url() {
    return EXPORT;
  }

  override async fetchRaw(_cond: ConditionalReq): Promise<RawFetch> {
    if (!BASE) {
      const url = new URL('../../fixtures/hospitales.json', import.meta.url);
      return { notModified: false, body: readFileSync(url, 'utf8'), etag: null, lastModified: null };
    }
    const res = await fetch(EXPORT, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${EXPORT}`);
    return { notModified: false, body: await res.text(), etag: null, lastModified: null };
  }

  parse(body: string): RawRecord[] {
    const data = JSON.parse(body);
    // El export (/descargar) usa `pacientes`; el listado (/pacientes) usa `results`.
    const items: any[] = Array.isArray(data)
      ? data : (data.pacientes ?? data.results ?? data.items ?? []);
    const out: RawRecord[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const name = strOrUndef(it?.nombre_completo);
      if (!name) continue;
      const estado = String(it?.estado ?? '');
      if (/fallec/i.test(estado)) continue; // nunca "a salvo"
      const id = String(it.id);
      if (seen.has(id)) continue;
      seen.add(id);
      // El padrón MEZCLA estados. "Hospitalizado / Refugiado / De Alta / Traslado…"
      // = hallado con vida → localizado. Pero "En Búsqueda" / "Por confirmar" siguen
      // DESAPARECIDOS → sin_contacto: marcarlos "a salvo" da falsa esperanza a la
      // familia (una tía buscada 6 días figuraba "Localizado" por este bug).
      const stillMissing = /b[úu]squeda|por\s*confirmar/i.test(estado);
      const status: Status = stillMissing ? 'sin_contacto' : 'localizado';
      // Si sigue en búsqueda, `hospital` suele venir como "En Búsqueda" (placeholder,
      // no un hospital real) → no lo usamos de referencia; el sector (origen) sí sirve.
      const hospital = stillMissing ? undefined : strOrUndef(it.hospital);
      const sector = strOrUndef(it.sector);
      const reference = [hospital, sector].filter(Boolean).join(' · ') || undefined;
      out.push({
        sourceId: id,
        sourceUrl: `${BASE}/`,
        fullName: name,
        cedula: cleanCedula(it.cedula), // campo estructurado → clave de merge
        age: numOrUndef(it.edad),
        gender: undefined,
        reference,
        photoUrl: undefined,
        status,
        lastSeenAt: strOrUndef(it.processed_at),
        raw: it,
      });
    }
    return out;
  }
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
