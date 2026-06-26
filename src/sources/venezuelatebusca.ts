/**
 * Adaptador JSON para venezuelatebusca.com.
 * Trae CÉDULA → es la mejor primera fuente para deduplicar.
 *
 * ⚠️ CONECTAR LA FUENTE REAL: F12 → Network → Fetch/XHR, encontrá el endpoint
 * JSON del buscador, pegalo en ENDPOINT y ajustá parse() a la forma real.
 * Mientras ENDPOINT esté vacío, corre en modo FIXTURES (sin tocar sus servidores).
 */
import { readFileSync } from 'node:fs';
import type {
  RawRecord, ConditionalReq, RawFetch, Status, SourceConfig,
} from '../types.ts';
import { BaseHttpAdapter, politeFetch, DEFAULT_CONFIG } from './base.ts';

const ENDPOINT = ''; // ← URL del JSON real cuando la tengas

export class VenezuelaTeBuscaAdapter extends BaseHttpAdapter {
  readonly domain = 'venezuelatebusca.com';
  readonly config: SourceConfig = { ...DEFAULT_CONFIG, intervalMinutes: 15 };

  protected url() {
    return ENDPOINT;
  }

  /** En modo fixtures leemos un archivo local en vez de pegarle a la web. */
  override async fetchRaw(cond: ConditionalReq): Promise<RawFetch> {
    if (!ENDPOINT) {
      const url = new URL('../../fixtures/venezuelatebusca.json', import.meta.url);
      return { notModified: false, body: readFileSync(url, 'utf8'), etag: null, lastModified: null };
    }
    return politeFetch(ENDPOINT, cond, this.config.minDelayMs);
  }

  parse(body: string): RawRecord[] {
    const data = JSON.parse(body);
    const items: any[] = Array.isArray(data) ? data : (data.records ?? data.data ?? []);
    return items.map((it) => ({
      sourceId: String(it.id),
      sourceUrl: it.id ? `https://${this.domain}/persona/${it.id}` : undefined,
      fullName: it.nombre_completo ?? it.nombre ?? '',
      cedula: it.cedula ?? undefined,
      age: it.edad != null ? Number(it.edad) : undefined,
      gender: it.genero ?? undefined,
      state: it.estado ?? undefined,
      city: it.ciudad ?? undefined,
      reference: it.referencia ?? it.sector ?? undefined,
      photoUrl: it.foto_url ?? undefined,
      status: mapStatus(it.estatus ?? it.status),
      lastSeenAt: it.visto_por_ultima_vez ?? undefined,
      raw: it,
    }));
  }
}

function mapStatus(s?: string): Status {
  const v = (s ?? '').toLowerCase();
  if (v.includes('localiz') || v.includes('encontr') || v.includes('safe')) return 'localizado';
  return 'sin_contacto';
}
