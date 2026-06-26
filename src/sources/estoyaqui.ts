/**
 * Adaptador para "Estoy Aquí Venezuela" (estoyaquive.up.railway.app).
 * Plataforma ciudadana de desaparecidos del terremoto; trae CÉDULA.
 *
 * API real (backend en Railway):
 *   GET /api/encontradas   → { total, items: [...] }  personas REPORTADAS A SALVO
 *   GET /api/estadisticas  → { total_buscados, total_encontrados, matches_confirmados }
 *   GET /api/buscar?q=|cedula=  búsqueda puntual (no hay listado masivo de buscados)
 *
 * Conectamos /api/encontradas: trae a los YA ENCONTRADOS con cédula, que es
 * justo la "buena noticia" que el agregador quiere propagar (status=localizado).
 * El listado de buscados no se expone en bloque (solo búsqueda puntual), así que
 * de esta fuente ingerimos los encontrados.
 *
 * Para volver a modo FIXTURES (offline), poné ENDPOINT = ''.
 */
import { readFileSync } from 'node:fs';
import type {
  RawRecord, ConditionalReq, RawFetch, Status, SourceConfig,
} from '../types.ts';
import { BaseHttpAdapter, politeFetch, DEFAULT_CONFIG } from './base.ts';

const ENDPOINT = 'https://estoyaquive.up.railway.app/api/encontradas';

export class EstoyAquiAdapter extends BaseHttpAdapter {
  readonly domain = 'estoyaquive.up.railway.app';
  readonly config: SourceConfig = { ...DEFAULT_CONFIG, intervalMinutes: 60 };

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
      : (data.items ?? data.resultados ?? data.personas ?? data.data ?? data.records ?? []);
    return items.map((it) => {
      // /api/encontradas devuelve personas ya halladas → la buena noticia.
      const yaHallado =
        it.estado_salud != null || it.ubicacion_actual != null || it.reportado_por != null;
      return {
        sourceId: String(it.id ?? it._id ?? ''),
        sourceUrl: `https://${this.domain}/`,
        fullName: it.nombre_completo ?? it.nombre ?? '',
        cedula: it.cedula ?? it.documento ?? undefined,
        age: it.edad_aproximada != null ? Number(it.edad_aproximada)
          : it.edad != null ? Number(it.edad) : undefined,
        gender: it.genero ?? it.sexo ?? undefined,
        state: it.estado ?? undefined,
        city: it.municipio ?? it.ciudad ?? undefined,
        reference: it.ubicacion_actual ?? it.descripcion_fisica ?? it.descripcion ?? it.sector ?? undefined,
        photoUrl: it.foto_url ?? it.foto ?? undefined,
        status: mapStatus(it.estatus ?? it.estado_busqueda ?? it.status, yaHallado),
        lastSeenAt: it.fecha_reporte ?? it.visto_por_ultima_vez ?? it.fecha ?? undefined,
        raw: it,
      };
    });
  }
}

function mapStatus(s: string | undefined, yaHallado = false): Status {
  const v = (s ?? '').toLowerCase();
  if (yaHallado || v.includes('localiz') || v.includes('encontr') || v.includes('safe') || v.includes('salvo'))
    return 'localizado';
  return 'sin_contacto';
}
