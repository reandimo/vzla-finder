#!/usr/bin/env -S node --experimental-sqlite
/**
 * CLI mínima para probar el pipeline hoy.
 *
 *   npm run ingest                 # corre todas las fuentes
 *   npm run search -- --cedula V-12.345.678
 *   npm run search -- --name "jose perez"
 */
import { Store } from './db.ts';
import { runAll } from './runner.ts';
import { startScheduler } from './scheduler.ts';
import { searchByCedula, searchByName } from './search.ts';
import type { ConsolidatedPerson } from './types.ts';

const DB_PATH = process.env.VZLA_DB ?? 'data.db';

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'watch') {
    startScheduler(DB_PATH);
    return; // el scheduler corre indefinidamente
  }

  const store = new Store(DB_PATH);

  if (cmd === 'ingest') {
    const stats = await runAll(store);
    console.table(stats);
    return;
  }

  if (cmd === 'search') {
    const flags = parseFlags(rest);
    if (flags.cedula) {
      const r = searchByCedula(store, flags.cedula);
      r ? printPerson(r) : console.log('Sin resultados por cédula.');
    } else if (flags.name) {
      const rs = searchByName(store, flags.name);
      if (!rs.length) console.log('Sin resultados por nombre.');
      rs.forEach(printPerson);
    } else {
      console.log('Usá --cedula <ced> o --name "<nombre>"');
    }
    return;
  }

  console.log('Comandos: ingest | watch | search');
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) out[args[i].slice(2)] = args[i + 1] ?? '';
  }
  return out;
}

function printPerson(p: ConsolidatedPerson) {
  const badge =
    p.consolidatedStatus === 'localizado' ? '✅ LOCALIZADO' : '🔴 SIN CONTACTO';
  console.log('\n' + '─'.repeat(48));
  console.log(`${badge}  ${p.fullName}`);
  console.log(`  cédula: ${p.cedula ?? '—'}   edad: ${p.age ?? '—'}   estado: ${p.lastSeenState ?? '—'}`);
  if (p.consolidatedStatus === 'localizado')
    console.log(`  reportado a salvo por: ${p.resolvedBy} (${p.resolvedAt})`);
  console.log(`  reportado en ${p.sources.length} fuente(s):`);
  for (const s of p.sources) {
    console.log(`    • ${s.sourceDomain}  →  ${s.sourceUrl ?? '(sin link)'}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
