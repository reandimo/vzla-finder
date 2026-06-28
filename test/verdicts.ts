/**
 * Almacén de veredictos de IA (ai_match_verdicts).
 *   npm run test:verdicts
 *
 * El par se guarda ordenado (a<b), así (a,b) y (b,a) son la misma fila; re-juzgar
 * sobreescribe (ON CONFLICT); y se puede recuperar por cualquiera de los dos ids.
 */
import { Store, type AiVerdict } from '../src/db.ts';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? '✅' : '❌'} ${n}`); c ? pass++ : fail++; };

const store = new Store(':memory:');
const now = '2026-06-28T00:00:00Z';
const v: AiVerdict = {
  personIdA: 'pB', personIdB: 'pA', // a propósito desordenado
  verdict: 'same', confidence: 0.9, reason: 'mismo nombre, misma edad',
  model: 'claude-haiku-4-5', pairHash: 'h1', createdAt: now,
};
store.upsertVerdict(v);

check('recupera el veredicto en el orden dado (B,A)', store.getVerdict('pB', 'pA')?.verdict === 'same');
check('recupera el mismo veredicto en orden inverso (A,B)', store.getVerdict('pA', 'pB')?.confidence === 0.9);
check('par inexistente → null', store.getVerdict('pX', 'pY') === null);

// Re-juzgar el mismo par (en orden inverso) sobreescribe, no duplica.
store.upsertVerdict({ ...v, personIdA: 'pA', personIdB: 'pB', verdict: 'different', confidence: 0.4, pairHash: 'h2' });
const after = store.getVerdict('pA', 'pB');
check('re-juzgar sobreescribe (verdict y pairHash nuevos)', after?.verdict === 'different' && after?.pairHash === 'h2');
check('no se duplicó la fila', store.verdictsForPerson('pA').length === 1);

// verdictsForPerson trae los que tocan a la persona, por cualquier lado del par.
store.upsertVerdict({ ...v, personIdA: 'pA', personIdB: 'pC', verdict: 'unsure', confidence: 0.5, pairHash: 'h3' });
check('verdictsForPerson trae todos los pares que tocan a pA', store.verdictsForPerson('pA').length === 2);
check('verdictsForPerson de pC trae solo el suyo', store.verdictsForPerson('pC').length === 1);

console.log(`\n${pass} OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
