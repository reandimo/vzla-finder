/**
 * Desempate de posibles duplicados SIN cédula (Stage 2-3 del flujo).
 *
 * Flujo: cédula ya fusionó (Stage 0) → recall arma clusters de candidatos
 * (Stage 1, src/recall.ts) → un JUEZ decide qué registros son la misma persona
 * (Stage 2) → se persiste un veredicto por par en ai_match_verdicts. **NUNCA
 * fusiona**: el veredicto es una pista de confianza, auditable y reversible, que
 * el front usa para agrupar/rankear mejor la etiqueta "posible duplicado".
 *
 * El juez puede ser:
 *   (a) la API de Anthropic (automático, necesita AI_DEDUP_API_KEY), o
 *   (b) Claude vía Claude Code, en dos pasos `dump` + `apply` (sin API key).
 *
 * MODOS (primer argumento):
 *   (sin arg)        Juzga con Anthropic. Sin AI_DEDUP_API_KEY → DRY RUN (reporta
 *                    clusters, no gasta ni escribe).
 *   dump             Emite los clusters candidatos como JSON (con ids) por stdout,
 *                    para que un juez externo (Claude) los evalúe.
 *   apply <archivo>  Lee un JSON de juicios y persiste los veredictos.
 *
 * Formato de `apply` (un objeto por cluster):
 *   [{ "members": ["id0","id1",...],   // ids en el MISMO orden del dump
 *      "groups": [[0,1],[2]],          // índices que son la MISMA persona
 *      "confidence": 0.9, "reason": "...", "diff": "..." }]
 * Pares dentro de un grupo → "same"; el resto → "different".
 *
 *   VZLA_DB=/ruta/data.db node --experimental-sqlite --experimental-transform-types \
 *     scripts/ai-dedup.ts dump > clusters.json
 *   ... (Claude juzga y escribe juicios.json) ...
 *   VZLA_DB=/ruta/data.db node ... scripts/ai-dedup.ts apply juicios.json
 *
 * Env: VZLA_DB, AI_DEDUP_API_KEY, AI_DEDUP_MODEL (default claude-haiku-4-5),
 *      AI_JUDGE_MODEL (etiqueta del juez en apply, default manual-claude),
 *      MAX_CLUSTERS (200), MAX_CLUSTER_SIZE (12), DELAY_MS (350).
 *
 * PRIVACIDAD: al juez NO va la cédula (no hace falta; ya resolvió por exacto).
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Store, type AiVerdict } from '../src/db.ts';
import { buildDupClusters } from '../src/recall.ts';
import type { PersonRecord } from '../src/types.ts';

const DB = process.env.VZLA_DB ?? 'data.db';
const API_KEY = process.env.AI_DEDUP_API_KEY ?? '';
const MODEL = process.env.AI_DEDUP_MODEL ?? 'claude-haiku-4-5';
const JUDGE_MODEL = process.env.AI_JUDGE_MODEL ?? 'manual-claude';
const MAX_CLUSTERS = Number(process.env.MAX_CLUSTERS ?? 200);
const MAX_CLUSTER_SIZE = Number(process.env.MAX_CLUSTER_SIZE ?? 12);
const DELAY_MS = Number(process.env.DELAY_MS ?? 350);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Datos salientes que ve el juez (SIN cédula). El hash cambia si cambian → re-juzgar. */
function signature(p: PersonRecord): string {
  return [p.nameNormalized, p.age ?? '', p.lastSeenRef ?? '', p.lastSeenState ?? '', p.lastSeenCity ?? ''].join('|');
}
function pairHash(a: PersonRecord, b: PersonRecord): string {
  return createHash('sha256').update([signature(a), signature(b)].sort().join('||')).digest('hex').slice(0, 16);
}
function pairsOf<T>(arr: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
  return out;
}
function clusterIsCached(store: Store, members: PersonRecord[]): boolean {
  for (const [a, b] of pairsOf(members)) {
    const v = store.getVerdict(a.personId, b.personId);
    if (!v || v.pairHash !== pairHash(a, b)) return false;
  }
  return true;
}

/** Veredictos por par a partir de grupos de índices que SON la misma persona. */
function verdictsFromGroups(
  members: PersonRecord[], groups: number[][], conf: number, reason: string, diff: string, model: string, now: string,
): AiVerdict[] {
  const groupOf = new Array(members.length).fill(-1);
  groups.forEach((g, gi) => g.forEach((idx) => { if (idx >= 0 && idx < members.length) groupOf[idx] = gi; }));
  const out: AiVerdict[] = [];
  for (let a = 0; a < members.length; a++) {
    for (let b = a + 1; b < members.length; b++) {
      const same = groupOf[a] >= 0 && groupOf[a] === groupOf[b];
      out.push({
        personIdA: members[a].personId, personIdB: members[b].personId,
        verdict: same ? 'same' : 'different',
        confidence: same ? conf : 0.6,
        reason: same ? reason : (diff || 'el juez los puso en grupos distintos'),
        model, pairHash: pairHash(members[a], members[b]), createdAt: now,
      });
    }
  }
  return out;
}

function buildClusters(store: Store) {
  const persons = store.personsWithoutCedula(null);
  const clusters = buildDupClusters(persons).sort((a, b) => b.members.length - a.members.length);
  return {
    persons,
    work: clusters.filter((c) => c.members.length <= MAX_CLUSTER_SIZE),
    big: clusters.filter((c) => c.members.length > MAX_CLUSTER_SIZE),
    total: clusters.length,
  };
}

// ---------- modo: dump ----------
function runDump(store: Store) {
  const { work } = buildClusters(store);
  const dump = work.slice(0, MAX_CLUSTERS).map((c, i) => ({
    cluster: i,
    members: c.members.map((m, j) => ({
      idx: j, id: m.personId, name: m.fullName,
      age: m.age, ref: m.lastSeenRef, state: m.lastSeenState, city: m.lastSeenCity,
    })),
  }));
  process.stdout.write(JSON.stringify(dump) + '\n');
}

// ---------- modo: apply ----------
function runApply(store: Store, file: string) {
  const judgments = JSON.parse(readFileSync(file, 'utf8')) as Array<{
    members: string[]; groups: number[][]; confidence?: number; reason?: string; diff?: string;
  }>;
  const now = new Date().toISOString();
  let same = 0, diff = 0, skipped = 0;
  for (const j of judgments) {
    const members = j.members.map((id) => store.getPerson(id)).filter(Boolean) as PersonRecord[];
    if (members.length !== j.members.length) { skipped++; continue; } // datos cambiaron desde el dump
    const vs = verdictsFromGroups(
      members, j.groups ?? [], j.confidence ?? 0.8, j.reason ?? '', j.diff ?? '', JUDGE_MODEL, now,
    );
    for (const v of vs) { store.upsertVerdict(v); v.verdict === 'same' ? same++ : diff++; }
  }
  console.log(`[ai-dedup apply] juicios=${judgments.length} · veredictos same=${same} different=${diff} · saltados=${skipped} · modelo=${JUDGE_MODEL}`);
}

// ---------- modo: Anthropic (default) ----------
const SYSTEM = [
  'Eres un asistente de resolución de entidades para un buscador de personas desaparecidas tras el terremoto de Venezuela (2026).',
  'Te doy un grupo de registros con nombres parecidos (sin cédula). Decide qué índices se refieren a LA MISMA persona real.',
  'Prioridad de señales: 1) nombre (tolera typos, orden de apellidos, acentos); 2) si hay varios parecidos, desempata con edad, última referencia y zona.',
  'Sé CONSERVADOR: ante la duda, trátalos como distintos. Es peligroso fusionar a dos personas distintas (escondería a un desaparecido).',
  'Responde SOLO con JSON válido, sin texto extra, con esta forma:',
  '{"groups":[{"indices":[0,2],"confidence":0.0-1.0,"reason":"breve"}]}',
  'Cada índice debe aparecer en exactamente un grupo. Un grupo de un solo índice = ese registro no coincide con ningún otro.',
].join('\n');

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

async function judgeWithApi(members: PersonRecord[]): Promise<number[][]> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1024, system: SYSTEM,
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
  // Devolvemos solo los índices por grupo; confianza/razón se promedian abajo.
  return parsed.groups.map((g: any) => g.indices as number[]);
}

async function runAuto(store: Store) {
  const { persons, work, big, total } = buildClusters(store);
  const DRY_RUN = !API_KEY;
  console.log(`[ai-dedup] db=${DB} · sin cédula=${persons.length} · clusters=${total} ` +
    `(juzgables=${work.length}, saltados>${MAX_CLUSTER_SIZE}=${big.length}) · ${DRY_RUN ? 'DRY RUN' : `modelo=${MODEL}`}`);

  if (DRY_RUN) {
    for (const c of work.slice(0, 25)) console.log(`\n— cluster (${c.members.length}) —\n${describeCluster(c.members)}`);
    console.log(`\n[ai-dedup] DRY RUN: ${work.length} clusters listos. Setea AI_DEDUP_API_KEY (o usá dump/apply con Claude).`);
    return;
  }

  let judged = 0, cached = 0, pairs = 0, errors = 0;
  const now = new Date().toISOString();
  for (const c of work) {
    if (judged >= MAX_CLUSTERS) break;
    if (clusterIsCached(store, c.members)) { cached++; continue; }
    try {
      const groups = await judgeWithApi(c.members);
      for (const v of verdictsFromGroups(c.members, groups, 0.8, 'IA: misma persona', 'IA: grupos distintos', MODEL, now)) {
        store.upsertVerdict(v); pairs++;
      }
      judged++;
    } catch (err) {
      console.error(`[ai-dedup] cluster "${c.members[0].fullName}" falló: ${(err as Error).message}`);
      errors++;
    }
    await sleep(DELAY_MS);
  }
  console.log(`[ai-dedup] LISTO · juzgados=${judged} · cacheados=${cached} · veredictos=${pairs} · errores=${errors}`);
}

// ---------- dispatch ----------
const store = new Store(DB);
const mode = process.argv[2];
if (mode === 'dump') runDump(store);
else if (mode === 'apply') {
  if (!process.argv[3]) { console.error('uso: ai-dedup.ts apply <archivo.json>'); process.exit(1); }
  runApply(store, process.argv[3]);
} else {
  await runAuto(store);
}
