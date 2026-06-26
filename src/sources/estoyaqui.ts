/**
 * Adaptador para "Estoy Aquí Venezuela" (estoyaquive.up.railway.app).
 * Plataforma ciudadana de desaparecidos del terremoto; trae CÉDULA.
 *
 * API real detectada en su bundle (backend en Railway). Endpoints útiles:
 *   GET /api/buscar           búsqueda (probablemente requiere query)
 *   GET /api/encontradas      personas reportadas como encontradas
 *   GET /api/estadisticas     totales
 *   GET /api/matches          cruces automáticos buscado/encontrado
 *
 * ⚠️ CONECTAR LA FUENTE REAL: no se confirmó un endpoint de "listar todos los
 * desaparecidos". Inspeccioná con F12 → Network/XHR cuál devuelve el listado
 * completo, ponelo en ENDPOINT y ajustá parse() a la forma real del JSON.
 * Mientras ENDPOINT esté vacío, corre en modo FIXTURES (sin tocar su servidor).
 */
import { readFileSync } from 'node:fs';
import type {
  RawRecord, ConditionalReq, RawFetch, Status, SourceConfig,
} from '../types.ts';
import { BaseHttpAdapter, politeFetch, DEFAULT_CONFIG } from './base.ts';

const ENDPOINT = ''; // ← p. ej. 'https://estoyaquive.up.railway.app/api/...'

export class EstoyAquiAdapter extends BaseHttpAdapter {
  readonly domain = 'estoyaquive.up.railway.app';
  readonly config: SourceConfig = { ...DEFAULT_CONFIG, intervalMinutes: 15 };

  protected url() {
    return ENDPOINT;
  }

  /** En modo fixtures leemos un archivo local en vez de pegarle a la web. */
  override async fetchRaw(cond: ConditionalReq): Promise<RawFetch> {
    if (!ENDPOINT) {
      const url = new URL('../../fixtures/estoyaqui.json', import.meta.url);
      return { notModified: false, body: readFileSync(url, 'utf8'), etag: null, lastModified: null };
    }
    return politeFetch(ENDPOINT, cond, this.config.minDelayMs);
  }

  parse(body: string): RawRecord[] {
    const data = JSON.parse(body);
    const items: any[] = Array.isArray(data)
      ? data
      : (data.resultados ?? data.personas ?? data.data ?? data.records ?? []);
    return items.map((it) => ({
      sourceId: String(it.id ?? it._id ?? ''),
      sourceUrl: it.id ? `https://${this.domain}/persona/${it.id}` : undefined,
      fullName: it.nombre_completo ?? it.nombre ?? '',
      cedula: it.cedula ?? it.documento ?? undefined,
      age: it.edad != null ? Number(it.edad) : undefined,
      gender: it.genero ?? it.sexo ?? undefined,
      state: it.estado ?? undefined,
      city: it.municipio ?? it.ciudad ?? undefined,
      reference: it.descripcion ?? it.sector ?? it.lugar ?? undefined,
      photoUrl: it.foto_url ?? it.foto ?? undefined,
      status: mapStatus(it.estatus ?? it.estado_busqueda ?? it.status),
      lastSeenAt: it.visto_por_ultima_vez ?? it.fecha ?? undefined,
      raw: it,
    }));
  }
}

function mapStatus(s?: string): Status {
  const v = (s ?? '').toLowerCase();
  if (v.includes('localiz') || v.includes('encontr') || v.includes('safe') || v.includes('salvo'))
    return 'localizado';
  return 'sin_contacto';
}
