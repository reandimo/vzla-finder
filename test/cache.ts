/**
 * Prueba de la capa de caché del runner.
 *   npm run demo:cache
 */
import { Store } from '../src/db.ts';
import { runSource } from '../src/runner.ts';
import { VenezuelaTeBuscaAdapter } from '../src/sources/venezuelatebusca.ts';
import { searchByCedula } from '../src/search.ts';

const store = new Store(':memory:');
const adapter = new VenezuelaTeBuscaAdapter();

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? '✅' : '❌'} ${n}`); c ? pass++ : fail++; };

const first = await runSource(store, adapter);
check('1ª corrida: detecta cambio e ingiere', first.outcome === 'changed' && first.fetched === 3);

const second = await runSource(store, adapter);
check('2ª corrida (mismo contenido): NO re-ingiere', second.outcome === 'unchanged_hash');
check('2ª corrida: fetched=0 (se evitó el reproceso)', second.fetched === 0);

// La data igual quedó disponible para buscar.
const r = searchByCedula(store, 'V-12.345.678');
check('los datos siguen consultables tras el skip', r != null);

console.log(`\n${pass} OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
