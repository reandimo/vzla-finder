/**
 * PFIF-lite — modelo de datos común para agregar registros de desaparecidos
 * de múltiples plataformas ciudadanas.
 *
 * Inspirado en People Finder Interchange Format (PFIF):
 *  - PersonRecord: datos de identidad de una persona.
 *  - SourceLink:   procedencia. Una persona puede estar reportada en varios
 *                  silos; cada vínculo guarda de qué dominio/ID salió.
 *  - NoteRecord:   actualizaciones de ESTADO. No se sobreescribe la persona;
 *                  se agregan notas. Así "localizado" nunca pisa el historial.
 *
 * Regla central: el dato no se fusiona a ciegas. Cédula = match exacto.
 * Sin cédula = "posible coincidencia" para revisión, nunca merge automático.
 */

export type Status = 'sin_contacto' | 'localizado' | 'desconocido';

/** Registro crudo tal como lo emite un adaptador de fuente, antes de normalizar. */
export interface RawRecord {
  /** ID de la persona DENTRO de la fuente (para deduplicar re-scrapes). */
  sourceId: string;
  /** Link de vuelta a la ficha original (ahí está el contacto; no lo re-hosteamos). */
  sourceUrl?: string;
  fullName: string;
  cedula?: string;
  age?: number;
  gender?: string;
  state?: string;   // estado venezolano (La Guaira, Miranda, etc.)
  city?: string;
  reference?: string;
  photoUrl?: string;
  status?: Status;
  /** Marca temporal del último avistamiento, según la fuente. */
  lastSeenAt?: string;
  /** Payload original, por si hace falta depurar el mapeo. */
  raw?: unknown;
}

/** Persona canónica ya normalizada y deduplicada. */
export interface PersonRecord {
  personId: string;
  cedula: string | null;        // normalizada: "V12345678"
  fullName: string;
  nameNormalized: string;       // sin acentos, minúsculas, para fuzzy
  age: number | null;
  gender: string | null;
  lastSeenState: string | null;
  lastSeenCity: string | null;
  lastSeenRef: string | null;
  photoUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Procedencia: en qué fuente y con qué ID está reportada esta persona. */
export interface SourceLink {
  personId: string;
  sourceDomain: string;
  sourceId: string;
  sourceUrl: string | null;
  rawName: string;
  rawCedula: string | null;
  firstSeen: string;            // primer scrape donde apareció
  lastSeen: string;             // último scrape donde se confirmó
}

/** Actualización de estado atada a una persona y a la fuente que la reportó. */
export interface NoteRecord {
  noteId: string;
  personId: string;
  sourceDomain: string;
  status: Status;
  noteText: string | null;
  sourceTimestamp: string | null;
  ingestedAt: string;
}

/** Sugerencia de coincidencia entre dos personas SIN cédula. Requiere revisión humana. */
export interface MatchSuggestion {
  personIdA: string;
  personIdB: string;
  score: number;                // 0..1
  reason: string;
  createdAt: string;
}

/** Vista consolidada que ve la familia: una persona, todos los silos, un estado. */
export interface ConsolidatedPerson extends PersonRecord {
  /** "localizado" si CUALQUIER fuente lo reporta así (la buena noticia gana). */
  consolidatedStatus: Status;
  /** Quién reportó la buena noticia y cuándo. */
  resolvedBy: string | null;
  resolvedAt: string | null;
  sources: SourceLink[];
  notes: NoteRecord[];
}

/** Configuración por fuente. Cada silo puede tener su propio ritmo. */
export interface SourceConfig {
  /** Cada cuántos minutos se scrapea esta fuente. */
  intervalMinutes: number;
  /** Demora mínima entre requests al mismo host (cortesía). */
  minDelayMs: number;
  /** Jitter aleatorio para no alinear todas las fuentes en el mismo segundo. */
  jitterMs: number;
}

/** Datos de request condicional, para no re-descargar lo que no cambió. */
export interface ConditionalReq {
  etag: string | null;
  lastModified: string | null;
}

/** Resultado crudo de traer una fuente (antes de parsear). */
export interface RawFetch {
  /** true si el servidor respondió 304 Not Modified. */
  notModified: boolean;
  /** Cuerpo (JSON o HTML como texto). null si notModified o error. */
  body: string | null;
  etag: string | null;
  lastModified: string | null;
}

/**
 * Interfaz que implementa cada fuente. Separa explícitamente:
 *   fetchRaw() = CÓMO se trae (difiere: GET JSON, GET HTML, API con token…)
 *   parse()    = CÓMO se interpreta (difiere por la forma de cada sitio)
 * Agregar un silo = implementar estas dos cosas (o extender BaseHttpAdapter).
 */
export interface SourceAdapter {
  readonly domain: string;
  readonly config: SourceConfig;
  /** Trae el cuerpo crudo, idealmente con request condicional. */
  fetchRaw(cond: ConditionalReq): Promise<RawFetch>;
  /** Convierte el cuerpo crudo en registros normalizables. */
  parse(body: string): RawRecord[];
}

/** Snapshot persistido de la última traída exitosa de una fuente. */
export interface Snapshot {
  sourceDomain: string;
  contentHash: string;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: string;
  ok: boolean;
}
