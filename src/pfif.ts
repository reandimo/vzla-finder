/**
 * Exportación PFIF 1.4 (People Finder Interchange Format) de nuestra data.
 *
 * Endpoint público de federación: cualquier plataforma (Faro VE, etc.) puede
 * consumir nuestros registros consolidados en un estándar abierto. Es lo que
 * pedimos a las demás plataformas, así que lo ofrecemos también.
 *
 * PRIVACIDAD: el feed NO incluye cédula ni ningún PII de contacto. Solo lo que
 * ya es público en las fuentes (nombre, edad, ciudad/estado, foto, estado del
 * caso) + enlace de vuelta a cada fuente original. Atribución obligatoria y
 * opt-out, igual que un feed de federación responsable.
 */
import type { ConsolidatedPerson, Status } from './types.ts';

const NS = 'busquedaunificadavzla.com';
const AUTHOR = 'Búsqueda Unificada Venezuela';
const OPT_OUT = 'opt-out@busquedaunificadavzla.com';

/** Escapa texto para XML (& < > " '). */
function xml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string));
}

/** Estado consolidado → status de nota PFIF 1.4. */
function pfifStatus(s: Status): string {
  if (s === 'localizado') return 'believed_alive';
  if (s === 'sin_contacto') return 'believed_missing';
  return 'information_sought';
}

/** Una etiqueta simple, omitida si el valor está vacío. */
function tag(name: string, value: unknown, indent: string): string {
  if (value === null || value === undefined || value === '') return '';
  return `${indent}<pfif:${name}>${xml(value)}</pfif:${name}>\n`;
}

function personXml(p: ConsolidatedPerson): string {
  const id = `${NS}/${p.personId}`;
  const primary = p.sources[0];
  let out = '  <pfif:person>\n';
  out += tag('person_record_id', id, '    ');
  out += tag('entry_date', p.updatedAt, '    ');
  out += tag('author_name', AUTHOR, '    ');
  // Fuente original (de dónde salió el reporte), para atribución.
  out += tag('source_name', primary?.sourceDomain, '    ');
  out += tag('source_url', primary?.sourceUrl, '    ');
  out += tag('source_date', p.createdAt, '    ');
  out += tag('full_name', p.fullName, '    ');
  out += tag('age', p.age, '    ');
  out += tag('home_city', p.lastSeenCity, '    ');
  out += tag('home_state', p.lastSeenState, '    ');
  out += tag('photo_url', p.photoUrl, '    ');
  // Nota de estado (la "buena noticia gana"): localizado / sin contacto.
  out += '    <pfif:note>\n';
  out += tag('note_record_id', `${id}/n0`, '      ');
  out += tag('person_record_id', id, '      ');
  out += tag('author_name', p.resolvedBy ?? AUTHOR, '      ');
  out += tag('source_date', p.resolvedAt ?? p.updatedAt, '      ');
  out += tag('status', pfifStatus(p.consolidatedStatus), '      ');
  const text = p.consolidatedStatus === 'localizado'
    ? `Reportado a salvo${p.resolvedBy ? ` por ${p.resolvedBy}` : ''}.`
    : 'Sin contacto / desaparecido según los reportes ciudadanos.';
  out += tag('text', text, '      ');
  out += '    </pfif:note>\n';
  out += '  </pfif:person>\n';
  return out;
}

export interface PfifPage {
  offset: number;
  limit: number;
  total: number;
}

/** Serializa una página de personas consolidadas a un documento PFIF 1.4. */
export function toPfif(persons: ConsolidatedPerson[], page: PfifPage): string {
  const returned = persons.length;
  const nextOffset = page.offset + returned;
  const hasNext = nextOffset < page.total;
  const header =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!-- Búsqueda Unificada Venezuela — feed de federación PFIF 1.4. Datos públicos, sin PII (no incluye cédula).\n` +
    `     Atribución obligatoria + opt-out: ${OPT_OUT}.\n` +
    `     Página: offset=${page.offset} limit=${page.limit} devueltos=${returned} total=${page.total}.\n` +
    (hasNext ? `     Siguiente página: ?offset=${nextOffset}&limit=${page.limit} -->\n` : `     Última página. -->\n`) +
    `<pfif:pfif xmlns:pfif="http://zesty.ca/pfif/1.4/">\n`;
  return header + persons.map(personXml).join('') + `</pfif:pfif>\n`;
}
