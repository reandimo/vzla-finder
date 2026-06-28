/**
 * Desempate por IA de posibles duplicados SIN cédula (Stage 2-3 del flujo).
 *
 * Flujo: cédula ya fusionó (Stage 0) → recall arma clusters de candidatos
 * (Stage 1, src/recall.ts) → la IA puntúa cada cluster (Stage 2) → se persiste
 * un veredicto por par en ai_match_verdicts. **NUNCA fusiona**: el veredicto es
 * una pista de confianza, auditable y reversible, que el front usa para agrupar
 * y rankear mejor la etiqueta "posible duplicado".
 *
 * Es un stage OFFLINE, pensado para correr DESPUÉS del ingest a su propia
 * cadencia (cada 6-12 h), no en el camino caliente de la búsqueda. Idempotente
 * y cacheado: si un par ya tiene veredicto y sus datos no cambiaron (pair_hash),
 * no se re-paga.
 *
 * Sin API key → DRY RUN: reporta los clusters que MANDARÍA (para verificar el
 * recall) sin gastar tokens ni escribir nada.
 *
 *   VZLA_DB=/ruta/data.db AI_DEDUP_API_KEY=sk-ant-... \
 *     node --experimental-sqlite --experimental-transform-types scripts/ai-dedup.ts
 *
 * Env:
 *   VZLA_DB            ruta de la base (default data.db)
 *   AI_DEDUP_API_KEY   API key de Anthropic. Sin ella → dry run.
 *   AI_DEDUP_MODEL     modelo (default claude-haiku-4-5)
 *   MAX_CLUSTERS       máximo de clusters a juzgar por corrida (default 200)
 *   MAX_CLUSTER_SIZE   clusters más grandes se saltan (probable nombre común) (default 12)
 *   DELAY_MS           pausa entre llamadas al LLM (default 350)
 *
 * PRIVACIDAD: al prompt NO va la cédula (no hace falta; ya resolvió por exacto).
 * Solo nombre, edad, última referencia y zona — lo ya público.
 */
import { createHash } from 'node:crypto';
import { Store, type AiVerdict } from '../src/db.ts';
import { buildDupClusters } from '../src/recall.ts';
import type { PersonRecord } from '../src/types.ts';

const DB = process.env.VZLA_DB ?? 'data.db';
const API_KEY = process.env.AI_DEDUP_API_KEY ?? '';
const MODEL = process.env.AI_DEDUP_MODEL ?? 'claude-haiku-4-5';
const MAX_CLUSTERS = Number(process.env.MAX_CLUSTERS ?? 200);
const MAX_CLUSTER_SIZE = Number(process.env.MAX_CLUSTER_SIZE ?? 12);
const DELAY_MS = Number(process.env.DELAY_MS ?? 350);
const DRY_RUN = !API_KEY;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Datos salientes que ve la IA (SIN cédula). El hash cambia si cambian → re-juzgar. */
function signature(p: PersonRecord): string {
  return [p.nameNormalized, p.age ?? '', p.lastSeenRef ?? '', p.lastSeenState ?? '', p.lastSeenCity ?? '']
    .join('|');
}
function pairHash(a: PersonRecord, b: PersonRecord): string {
  const sigs = [signature(a), signature(b)].sort();
  return createHash('sha256').update(sigs.join('||')).digest('hex').slice(0, 16);
}

/** Pares (i<j) dentro de un cluster. */
function pairsOf<T>(arr: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
  return out;
}

/** ¿Ya están todos los pares de este cluster juzgados con los mismos datos? */
function clusterIsCached(store: Store, members: PersonRecord[]): boolean {
  for (const [a, b] of pairsOf(members)) {
    const v = store.getVerdict(a.personId, b.personId);
    if (!v || v.pairHash !== pairHash(a, b)) return false;
  }
  return true;
}

/** Describe un cluster para la IA: lista numerada, sin cédula. */
function describeCluster(members: PersonRecord[]): string {
  return members.map((p, i) => {
    const bits = [
      `nombre: ${p.fullName}`,
      p.age != null ? `edad: ${p.age}` : null,
      p.lastSeenState ? `estado: ${p.lastSeenState}` : null,
      p.lastSeenCity ? `ciudad: ${p.lastSeenCity}` : null,
      p.lastSeenRef ? `última referencia: ${p.lastSeenRef}` : null,
    ].filter(Boolean).join(' · ');
    return `[${i}] ${bits}`;
  }).join('\n');
}

const SYSTEM = [
  'Eres un asistente de resolución de entidades para un buscador de personas desaparecidas tras el terremoto de Venezuela (2026).',
  'Te doy un grupo de registros con nombres parecidos (sin cédula). Decide qué índices se refieren a LA MISMA persona real.',
  'Prioridad de señales: 1) nombre (tolera typos, orden de apellidos, acentos); 2) si hay varios parecidos, desempata con edad, última referencia y zona.',
  'Sé CONSERVADOR: ante la duda, marca "unsure" o trátalos como distintos. Es peligroso fusionar a dos personas distintas (escondería a un desaparecido).',
  'Responde SOLO con JSON válido, sin texto extra, con esta forma:',
  '{"groups":[{"indices":[0,2],"confidence":0.0-1.0,"reason":"breve"}]}',
  'Cada índice debe aparecer en exactamente un grupo. Un grupo de un solo índice = ese registro no coincide con ningún otro.',
].join('\n');

interface LlmGroup { indices: number[]; confidence: number; reason: string }

/** Llama a la API de Anthropic y devuelve los grupos. Lanza si la respuesta no parsea. */
async function judgeCluster(members: PersonRecord[]): Promise<LlmGroup[]> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Registros:\n${describeCluster(members)}` }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json() as any;
  const text: string = (data.content ?? []).map((b: any) => b.text ?? '').join('').trim();
  const json = text.startsWith('{') ? text : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed.groups)) throw new Error('respuesta sin "groups"');
  return parsed.groups;
}

/** Deriva veredictos por par a partir de los grupos que devolvió la IA. */
function verdictsFromGroups(
  members: PersonRecord[], groups: LlmGroup[], now: string,
): AiVerdict[] {
  // índice de persona -> id de grupo de la IA + confianza/razón de ese grupo
  const grpOf = new Map<number, number>();
  const meta = new Map<number, { confidence: number; reason: string }>();
  groups.forEach((g, gi) => {
    for (const idx of g.indices) {
      grpOf.set(idx, gi);
      meta.set(gi, { confidence: g.confidence, reason: g.reason });
    }
  });
  const out: AiVerdict[] = [];
  for (const [a, b] of pairsOf(members.map((_, i) => i))) {
    const same = grpOf.has(a) && grpOf.get(a) === grpOf.get(b);
    const m = same ? meta.get(grpOf.get(a)!) : null;
    out.push({
      personIdA: members[a].personId,
      personIdB: members[b].personId,
      verdict: same ? 'same' : 'different',
      confidence: m?.confidence ?? 0.5,
      reason: same ? (m?.reason ?? null) : 'la IA los puso en grupos distintos',
      model: MODEL,
      pairHash: pairHash(members[a], members[b]),
      createdAt: now,
    });
  }
  return out;
}

// --- main ---
const store = new Store(DB);
const persons = store.personsWithoutCedula(null);
const clusters = buildDupClusters(persons).sort((a, b) => b.members.length - a.members.length);

const big = clusters.filter((c) => c.members.length > MAX_CLUSTER_SIZE);
const work = clusters.filter((c) => c.members.length <= MAX_CLUSTER_SIZE);

console.log(`[ai-dedup] db=${DB} · personas sin cédula=${persons.length} · clusters=${clusters.length} ` +
  `(juzgables=${work.length}, saltados por tamaño>${MAX_CLUSTER_SIZE}=${big.length}) · ` +
  `${DRY_RUN ? 'DRY RUN (sin API key)' : `modelo=${MODEL}`}`);

if (big.length) {
  console.log(`[ai-dedup] ${big.length} cluster(s) gigantes saltados (probable nombre muy común): ` +
    big.slice(0, 5).map((c) => `${c.members[0].fullName}~${c.members.length}`).join(', ') +
    (big.length > 5 ? '…' : ''));
}

if (DRY_RUN) {
  // Muestreo: reporta clusters representativos para verificar el recall.
  const sample = work.slice(0, 25);
  for (const c of sample) {
    console.log(`\n— cluster (${c.members.length}) —\n${describeCluster(c.members)}`);
  }
  console.log(`\n[ai-dedup] DRY RUN: ${work.length} clusters listos para juzgar. ` +
    `Mostrados ${sample.length}. Setea AI_DEDUP_API_KEY para puntuarlos con la IA.`);
  process.exit(0);
}

let judged = 0, cached = 0, pairs = 0, errors = 0;
const now = new Date().toISOString();
for (const c of work) {
  if (judged >= MAX_CLUSTERS) { console.log(`[ai-dedup] tope MAX_CLUSTERS=${MAX_CLUSTERS} alcanzado.`); break; }
  if (clusterIsCached(store, c.members)) { cached++; continue; }
  try {
    const groups = await judgeCluster(c.members);
    for (const v of verdictsFromGroups(c.members, groups, now)) { store.upsertVerdict(v); pairs++; }
    judged++;
  } catch (err) {
    console.error(`[ai-dedup] cluster "${c.members[0].fullName}" falló: ${(err as Error).message}`);
    errors++;
  }
  await sleep(DELAY_MS);
}

console.log(`[ai-dedup] LISTO · juzgados=${judged} · cacheados=${cached} · veredictos=${pairs} · errores=${errors}`);
