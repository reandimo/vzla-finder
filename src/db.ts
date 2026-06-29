/**
 * Capa de almacenamiento sobre node:sqlite (incluido en Node 22+, sin compilar
 * nada nativo). Para Node <22, cambiá la import por better-sqlite3: la API
 * (prepare/run/get/all/exec) es prácticamente idéntica.
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  PersonRecord,
  SourceLink,
  NoteRecord,
  MatchSuggestion,
  Snapshot,
} from './types.ts';

/** Veredicto de desempate por IA sobre un par de posibles duplicados (sin cédula). */
export interface AiVerdict {
  personIdA: string;
  personIdB: string;
  verdict: 'same' | 'different' | 'unsure';
  confidence: number; // 0..1
  reason: string | null;
  model: string;
  pairHash: string;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(path = 'data.db') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // Esperar el lock en vez de fallar al toque: clave cuando el web app, el cron
    // de ingesta y/o un backfill escriben a la vez (SQLITE_BUSY → "database is locked").
    this.db.exec('PRAGMA busy_timeout = 8000;');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS persons (
        person_id        TEXT PRIMARY KEY,
        cedula           TEXT UNIQUE,
        full_name        TEXT NOT NULL,
        name_normalized  TEXT NOT NULL,
        age              INTEGER,
        gender           TEXT,
        last_seen_state  TEXT,
        last_seen_city   TEXT,
        last_seen_ref    TEXT,
        photo_url        TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_persons_name ON persons(name_normalized);
      CREATE INDEX IF NOT EXISTS idx_persons_state ON persons(last_seen_state);

      CREATE TABLE IF NOT EXISTS source_links (
        person_id     TEXT NOT NULL,
        source_domain TEXT NOT NULL,
        source_id     TEXT NOT NULL,
        source_url    TEXT,
        raw_name      TEXT NOT NULL,
        raw_cedula    TEXT,
        first_seen    TEXT NOT NULL,
        last_seen     TEXT NOT NULL,
        PRIMARY KEY (source_domain, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_links_person ON source_links(person_id);

      CREATE TABLE IF NOT EXISTS notes (
        note_id          TEXT PRIMARY KEY,
        person_id        TEXT NOT NULL,
        source_domain    TEXT NOT NULL,
        status           TEXT NOT NULL,
        note_text        TEXT,
        source_timestamp TEXT,
        ingested_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_person ON notes(person_id);

      CREATE TABLE IF NOT EXISTS match_suggestions (
        person_id_a TEXT NOT NULL,
        person_id_b TEXT NOT NULL,
        score       REAL NOT NULL,
        reason      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (person_id_a, person_id_b)
      );

      -- Cache nuestro: última traída por fuente (ETag / Last-Modified / hash).
      CREATE TABLE IF NOT EXISTS source_snapshots (
        source_domain TEXT PRIMARY KEY,
        content_hash  TEXT NOT NULL,
        etag          TEXT,
        last_modified TEXT,
        fetched_at    TEXT NOT NULL,
        ok            INTEGER NOT NULL
      );

      -- Sugerencias de nuevas fuentes que mandan los visitantes desde el landing.
      CREATE TABLE IF NOT EXISTS source_suggestions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT,
        url        TEXT NOT NULL,
        note       TEXT,
        created_at TEXT NOT NULL
      );

      -- Veredictos del desempate por IA sobre posibles duplicados SIN cédula.
      -- NUNCA fusiona: solo es una pista de confianza, auditable y reversible
      -- (ver scripts/ai-dedup.ts). El par se guarda ordenado (a < b) para que
      -- (a,b) y (b,a) sean la misma fila. pair_hash detecta si los datos de
      -- entrada cambiaron desde el último veredicto (para no re-pagar tokens).
      CREATE TABLE IF NOT EXISTS ai_match_verdicts (
        person_id_a TEXT NOT NULL,
        person_id_b TEXT NOT NULL,
        verdict     TEXT NOT NULL,   -- 'same' | 'different' | 'unsure'
        confidence  REAL NOT NULL,   -- 0..1
        reason      TEXT,
        model       TEXT NOT NULL,   -- p. ej. 'claude-haiku-4-5' o 'dry-run'
        pair_hash   TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (person_id_a, person_id_b)
      );
      CREATE INDEX IF NOT EXISTS idx_verdicts_a ON ai_match_verdicts(person_id_a);
      CREATE INDEX IF NOT EXISTS idx_verdicts_b ON ai_match_verdicts(person_id_b);
    `);
  }

  // --- persons ---
  findPersonByCedula(cedula: string): PersonRecord | null {
    const row = this.db
      .prepare('SELECT * FROM persons WHERE cedula = ?')
      .get(cedula) as any;
    return row ? rowToPerson(row) : null;
  }

  getPerson(personId: string): PersonRecord | null {
    const row = this.db
      .prepare('SELECT * FROM persons WHERE person_id = ?')
      .get(personId) as any;
    return row ? rowToPerson(row) : null;
  }

  /** Personas sin cédula, candidatas a fuzzy-match en un estado dado. */
  personsWithoutCedula(state: string | null): PersonRecord[] {
    const rows = state
      ? this.db
          .prepare(
            'SELECT * FROM persons WHERE cedula IS NULL AND last_seen_state IS ?',
          )
          .all(state)
      : this.db.prepare('SELECT * FROM persons WHERE cedula IS NULL').all();
    return (rows as any[]).map(rowToPerson);
  }

  upsertPerson(p: PersonRecord) {
    this.db
      .prepare(
        `INSERT INTO persons
          (person_id, cedula, full_name, name_normalized, age, gender,
           last_seen_state, last_seen_city, last_seen_ref, photo_url,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(person_id) DO UPDATE SET
           cedula=excluded.cedula, full_name=excluded.full_name,
           name_normalized=excluded.name_normalized, age=excluded.age,
           gender=excluded.gender, last_seen_state=excluded.last_seen_state,
           last_seen_city=excluded.last_seen_city, last_seen_ref=excluded.last_seen_ref,
           photo_url=excluded.photo_url, updated_at=excluded.updated_at`,
      )
      .run(
        p.personId, p.cedula, p.fullName, p.nameNormalized, p.age, p.gender,
        p.lastSeenState, p.lastSeenCity, p.lastSeenRef, p.photoUrl,
        p.createdAt, p.updatedAt,
      );
  }

  // --- source links ---
  getLinkBySource(domain: string, sourceId: string): SourceLink | null {
    const row = this.db
      .prepare('SELECT * FROM source_links WHERE source_domain=? AND source_id=?')
      .get(domain, sourceId) as any;
    return row ? rowToLink(row) : null;
  }

  upsertSourceLink(l: SourceLink) {
    this.db
      .prepare(
        `INSERT INTO source_links
          (person_id, source_domain, source_id, source_url, raw_name, raw_cedula, first_seen, last_seen)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(source_domain, source_id) DO UPDATE SET
           person_id=excluded.person_id, source_url=excluded.source_url,
           raw_name=excluded.raw_name, raw_cedula=excluded.raw_cedula,
           last_seen=excluded.last_seen`,
      )
      .run(
        l.personId, l.sourceDomain, l.sourceId, l.sourceUrl,
        l.rawName, l.rawCedula, l.firstSeen, l.lastSeen,
      );
  }

  linksForPerson(personId: string): SourceLink[] {
    const rows = this.db
      .prepare('SELECT * FROM source_links WHERE person_id=?')
      .all(personId);
    return (rows as any[]).map(rowToLink);
  }

  // --- notes ---
  addNote(n: NoteRecord) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO notes
          (note_id, person_id, source_domain, status, note_text, source_timestamp, ingested_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(n.noteId, n.personId, n.sourceDomain, n.status, n.noteText, n.sourceTimestamp, n.ingestedAt);
  }

  notesForPerson(personId: string): NoteRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM notes WHERE person_id=? ORDER BY ingested_at')
      .all(personId);
    return (rows as any[]).map(rowToNote);
  }

  // --- match suggestions ---
  addSuggestion(s: MatchSuggestion) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO match_suggestions
          (person_id_a, person_id_b, score, reason, created_at) VALUES (?,?,?,?,?)`,
      )
      .run(s.personIdA, s.personIdB, s.score, s.reason, s.createdAt);
  }

  // --- veredictos de IA (posibles duplicados sin cédula) ---
  upsertVerdict(v: AiVerdict) {
    const [a, b] = v.personIdA < v.personIdB
      ? [v.personIdA, v.personIdB] : [v.personIdB, v.personIdA];
    this.db
      .prepare(
        `INSERT INTO ai_match_verdicts
          (person_id_a, person_id_b, verdict, confidence, reason, model, pair_hash, created_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(person_id_a, person_id_b) DO UPDATE SET
           verdict=excluded.verdict, confidence=excluded.confidence,
           reason=excluded.reason, model=excluded.model,
           pair_hash=excluded.pair_hash, created_at=excluded.created_at`,
      )
      .run(a, b, v.verdict, v.confidence, v.reason, v.model, v.pairHash, v.createdAt);
  }

  /** Veredicto previo de un par (en cualquier orden), o null si no se juzgó. */
  getVerdict(personIdA: string, personIdB: string): AiVerdict | null {
    const [a, b] = personIdA < personIdB ? [personIdA, personIdB] : [personIdB, personIdA];
    const r = this.db
      .prepare('SELECT * FROM ai_match_verdicts WHERE person_id_a=? AND person_id_b=?')
      .get(a, b) as any;
    return r ? rowToVerdict(r) : null;
  }

  /** Todos los veredictos que tocan a una persona (para que el front agrupe/rankee). */
  verdictsForPerson(personId: string): AiVerdict[] {
    const rows = this.db
      .prepare('SELECT * FROM ai_match_verdicts WHERE person_id_a=? OR person_id_b=?')
      .all(personId, personId);
    return (rows as any[]).map(rowToVerdict);
  }

  /**
   * Veredictos cuyos DOS extremos están dentro de `personIds`. Para precargar de
   * una sola vez los juicios de IA relevantes a un set de resultados (la búsqueda
   * por nombre) y agrupar sin consultar par por par.
   */
  verdictsAmong(personIds: string[]): AiVerdict[] {
    if (personIds.length === 0) return [];
    const ph = personIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM ai_match_verdicts WHERE person_id_a IN (${ph}) AND person_id_b IN (${ph})`)
      .all(...personIds, ...personIds);
    return (rows as any[]).map(rowToVerdict);
  }

  // --- search ---
  /**
   * Candidatos cuyo nombre normalizado contiene CUALQUIERA de los tokens.
   *
   * Clave: ordena por CUÁNTOS tokens del query aparecen en el nombre ANTES de
   * cortar. Con un nombre común (p. ej. "maría" o "gonzález") puede haber miles
   * de coincidencias parciales; si cortáramos sin ordenar (LIMIT a secas), la
   * persona que matchea TODOS los tokens podría quedar fuera del corte y la
   * familia vería "sin resultados" aunque esté en la base. Al rankear por
   * cantidad de tokens, los matches más completos entran primero. El ranking
   * fino por similitud (con tolerancia a typos/orden) lo hace searchByName.
   */
  searchByNameTokens(tokens: string[]): PersonRecord[] {
    const clean = tokens.filter((t) => t.length >= 2);
    if (!clean.length) return [];
    const likeArgs = clean.map((t) => `%${t}%`);
    const where = clean.map(() => 'name_normalized LIKE ?').join(' OR ');
    // (name_normalized LIKE ?) da 1/0 en SQLite; la suma = nº de tokens presentes.
    const score = clean.map(() => '(name_normalized LIKE ?)').join(' + ');
    const rows = this.db
      .prepare(
        `SELECT * FROM persons WHERE ${where} ORDER BY (${score}) DESC LIMIT 800`,
      )
      // Primero los args del WHERE, luego los del ORDER BY (mismo orden de aparición).
      .all(...likeArgs, ...likeArgs);
    return (rows as any[]).map(rowToPerson);
  }

  allPersons(): PersonRecord[] {
    return (this.db.prepare('SELECT * FROM persons').all() as any[]).map(rowToPerson);
  }

  /** Total de personas únicas registradas (tras deduplicar). Para el landing. */
  countPersons(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM persons').get() as any).n;
  }

  /** Página estable de personas (para el feed público PFIF). Orden determinista. */
  listPersons(limit: number, offset: number): PersonRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM persons ORDER BY created_at, person_id LIMIT ? OFFSET ?')
      .all(limit, offset);
    return (rows as any[]).map(rowToPerson);
  }

  // --- sugerencias de fuentes ---
  addSourceSuggestion(s: { name: string | null; url: string; note: string | null; createdAt: string }) {
    this.db
      .prepare(
        `INSERT INTO source_suggestions (name, url, note, created_at) VALUES (?,?,?,?)`,
      )
      .run(s.name, s.url, s.note, s.createdAt);
  }

  listSourceSuggestions(): { id: number; name: string | null; url: string; note: string | null; createdAt: string }[] {
    const rows = this.db
      .prepare('SELECT * FROM source_suggestions ORDER BY created_at DESC')
      .all();
    return (rows as any[]).map((r) => ({
      id: r.id, name: r.name, url: r.url, note: r.note, createdAt: r.created_at,
    }));
  }

  // --- snapshots (cache de fuentes) ---
  getSnapshot(domain: string): Snapshot | null {
    const r = this.db
      .prepare('SELECT * FROM source_snapshots WHERE source_domain = ?')
      .get(domain) as any;
    if (!r) return null;
    return {
      sourceDomain: r.source_domain,
      contentHash: r.content_hash,
      etag: r.etag,
      lastModified: r.last_modified,
      fetchedAt: r.fetched_at,
      ok: !!r.ok,
    };
  }

  saveSnapshot(s: Snapshot) {
    this.db
      .prepare(
        `INSERT INTO source_snapshots
          (source_domain, content_hash, etag, last_modified, fetched_at, ok)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(source_domain) DO UPDATE SET
           content_hash=excluded.content_hash, etag=excluded.etag,
           last_modified=excluded.last_modified, fetched_at=excluded.fetched_at,
           ok=excluded.ok`,
      )
      .run(s.sourceDomain, s.contentHash, s.etag, s.lastModified, s.fetchedAt, s.ok ? 1 : 0);
  }
}

function rowToPerson(r: any): PersonRecord {
  return {
    personId: r.person_id, cedula: r.cedula, fullName: r.full_name,
    nameNormalized: r.name_normalized, age: r.age, gender: r.gender,
    lastSeenState: r.last_seen_state, lastSeenCity: r.last_seen_city,
    lastSeenRef: r.last_seen_ref, photoUrl: r.photo_url,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function rowToLink(r: any): SourceLink {
  return {
    personId: r.person_id, sourceDomain: r.source_domain, sourceId: r.source_id,
    sourceUrl: r.source_url, rawName: r.raw_name, rawCedula: r.raw_cedula,
    firstSeen: r.first_seen, lastSeen: r.last_seen,
  };
}
function rowToNote(r: any): NoteRecord {
  return {
    noteId: r.note_id, personId: r.person_id, sourceDomain: r.source_domain,
    status: r.status, noteText: r.note_text, sourceTimestamp: r.source_timestamp,
    ingestedAt: r.ingested_at,
  };
}
function rowToVerdict(r: any): AiVerdict {
  return {
    personIdA: r.person_id_a, personIdB: r.person_id_b, verdict: r.verdict,
    confidence: r.confidence, reason: r.reason, model: r.model,
    pairHash: r.pair_hash, createdAt: r.created_at,
  };
}
