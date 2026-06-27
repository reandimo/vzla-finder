/**
 * Adaptador para afectadosporelterremotovenezuela.com (Next.js App Router, SSR).
 *
 * El listado se renderiza server-side (DOM real en el HTML), así que lo
 * scrapeamos con cheerio — igual que desaparecidos.ts, pero trayendo VARIAS
 * páginas de estado y combinándolas (como venezuelatebusca.ts).
 *
 * Páginas por estado:
 *   /desaparecidos   → "Sin Localizar"  → sin_contacto
 *   /hospitalizados  → "Hospitalizado"  → localizado (hallado con vida, herido)
 *   /rescatados      → "Rescatado"      → localizado (a salvo con sus familiares)
 *   /fallecidos      → NO se ingiere. Hoy está vacía y, sobre todo, el modelo no
 *                      representa la muerte: marcar a un fallecido como "a salvo"
 *                      sería falso e hiriente. Se excluye y se descarta cualquier
 *                      card "Fallecido" que aparezca por error.
 *
 * ⚠️ CÉDULA ENMASCARADA: la fuente publica la cédula como `V-14.XXX.917` (oculta
 * los dígitos centrales). NO sirve como clave de merge (dos personas comparten
 * el patrón), así que NO la ponemos en `cedula` — entra como PISTA visible en la
 * referencia y el registro cae al dedup por silo. Respetamos el enmascaramiento:
 * jamás intentamos completarla desde el backend.
 */
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import type {
  RawRecord, ConditionalReq, RawFetch, Status, SourceConfig,
} from '../types.ts';
import { BaseHttpAdapter, DEFAULT_CONFIG } from './base.ts';

const BASE = 'https://www.afectadosporelterremotovenezuela.com';
const UA = 'vzla-finder/1.0 (agregador solidario de desaparecidos; +https://busquedaunificadavzla.com)';

/** Páginas a traer y el estado consolidado que implica cada una. */
const PAGES: { path: string; status: Status }[] = [
  { path: '/desaparecidos', status: 'sin_contacto' },
  { path: '/hospitalizados', status: 'localizado' },
  { path: '/rescatados', status: 'localizado' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Campos etiquetados dentro de cada card (el texto viene concatenado sin separadores). */
const LABELS = [
  'Edad', 'Cédula', 'Nacionalidad', 'Visto en', 'Rescate en', 'Ubicación',
  'Centro médico', 'Rasgos físicos', 'Vestimenta', 'Salud',
  'Última actualización', 'Familiar',
];

export class AfectadosAdapter extends BaseHttpAdapter {
  readonly domain = 'afectadosporelterremotovenezuela.com';
  readonly config: SourceConfig = { ...DEFAULT_CONFIG, intervalMinutes: 30, minDelayMs: 2000 };

  protected url() {
    return BASE;
  }

  /** Trae las páginas de estado y las empaqueta (path + estado + html) en un solo cuerpo. */
  override async fetchRaw(_cond: ConditionalReq): Promise<RawFetch> {
    const bundle: { path: string; status: Status; html: string }[] = [];
    for (let i = 0; i < PAGES.length; i++) {
      const pg = PAGES[i];
      const res = await fetch(BASE + pg.path, {
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) {
        if (i === 0) throw new Error(`HTTP ${res.status} en ${BASE}${pg.path}`);
        continue; // una página secundaria que falla no aborta lo ya traído
      }
      bundle.push({ path: pg.path, status: pg.status, html: await res.text() });
      if (i < PAGES.length - 1) await sleep(this.config.minDelayMs);
    }
    return { notModified: false, body: JSON.stringify(bundle), etag: null, lastModified: null };
  }

  parse(body: string): RawRecord[] {
    const pages: { path: string; status: Status; html: string }[] = JSON.parse(body);
    const out: RawRecord[] = [];
    for (const pg of pages) {
      const $ = load(pg.html);
      const cards: any[] = [];
      $('h3.font-bold').each((_, h) => {
        const c = $(h).closest('div.rounded-xl').get(0);
        if (c) cards.push(c);
      });
      for (const el of cards) {
        const rec = parseCard($, el, pg.path, pg.status);
        if (rec) out.push(rec);
      }
    }
    return out;
  }
}

function parseCard($: any, el: any, path: string, pageStatus: Status): RawRecord | null {
  const $c = $(el);
  const name = $c.find('h3').first().text().trim();
  if (!name || /^No se encontraron|^No hay /i.test(name)) return null;

  const text = $c.text().replace(/\s+/g, ' ').trim();
  if (/Fallecid/i.test(text)) return null; // nunca tratamos un fallecido como "a salvo"

  const f = fieldMap(text);
  const ageMatch = (f['edad'] ?? '').match(/(\d{1,3})/);
  const age = ageMatch ? Number(ageMatch[1]) : undefined;

  // Cédula enmascarada → solo PISTA, nunca clave de merge.
  const rawCedula = f['cédula'] ?? '';
  const cedulaHint = /[VE]-[\dX.]+/i.test(rawCedula) && !/no registrad/i.test(rawCedula)
    ? rawCedula.trim()
    : undefined;

  const location = f['visto en'] || f['rescate en'] || f['ubicación'] || f['centro médico'] || undefined;
  const reference = [location, cedulaHint ? `Cédula parcial: ${cedulaHint}` : null]
    .filter(Boolean)
    .join(' · ') || undefined;

  const photoSrc = $c.find('img').first().attr('src');
  const photoUrl = photoSrc && /^https?:\/\//i.test(photoSrc) ? photoSrc : undefined;

  return {
    sourceId: makeId(name, cedulaHint, f['familiar'], location, f['edad']),
    sourceUrl: BASE + path,
    fullName: name,
    cedula: undefined, // la fuente enmascara la cédula: no es clave utilizable
    age,
    gender: undefined,
    reference,
    photoUrl,
    status: pageStatus,
    lastSeenAt: parseVeDate(f['última actualización']),
    raw: { name, cedulaHint, ...f },
  };
}

/** "Etiqueta: valor" hasta la siguiente etiqueta. El texto viene sin separadores. */
function fieldMap(text: string): Record<string, string> {
  const alt = LABELS.map(escapeRegex).join('|');
  const re = new RegExp(`(${alt})\\s*:\\s*(.*?)(?=(?:${alt})\\s*:|$)`, 'giu');
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const key = m[1].toLowerCase();
    if (!(key in out)) out[key] = m[2].trim();
  }
  return out;
}

/**
 * ID estable entre re-scrapes: la fuente no expone ID ni link por ficha, así que
 * lo derivamos de campos de identidad estables (nombre + cédula parcial + familiar
 * + ubicación + edad). Incluimos ubicación/edad para desambiguar homónimos sin
 * cédula (hospitalizados) y evitar colisiones que harían perder registros. NO
 * incluimos campos volátiles (última actualización, rasgos) para no romper la
 * estabilidad entre corridas.
 */
function makeId(
  name: string, cedulaHint?: string, familiar?: string, location?: string, age?: string,
): string {
  const norm = (s?: string) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const basis = [norm(name), cedulaHint ?? '', norm(familiar), norm(location), norm(age)].join('|');
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

/** "26/06/2026, 09:54 p.m. (hora Venezuela)" → ISO con offset de Venezuela (UTC-4). */
function parseVeDate(s?: string): string | undefined {
  if (!s) return undefined;
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?/i);
  if (!m) return undefined;
  const [, dd, mm, yyyy, hh, min, ap] = m;
  let h = Number(hh) % 12;
  if (/p/i.test(ap)) h += 12;
  return `${yyyy}-${mm}-${dd}T${String(h).padStart(2, '0')}:${min}:00-04:00`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
