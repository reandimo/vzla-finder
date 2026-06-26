/**
 * Flujos de normalización y similitud (cédula, nombre, fuzzy).
 *   npm run test:normalize
 */
import { normalizeCedula, normalizeName, nameSimilarity } from '../src/normalize.ts';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? '✅' : '❌'} ${n}`); c ? pass++ : fail++; };

// --- cédula: formatos equivalentes colapsan a la forma canónica ---
check('V con puntos/guion → V12345678', normalizeCedula('V-12.345.678') === 'V12345678');
check('minúscula y espacios → V12345678', normalizeCedula('v 12345678') === 'V12345678');
check('sin prefijo asume V', normalizeCedula('12.345.678') === 'V12345678');

// --- cédula: prefijos especiales ---
check('extranjero E se conserva', normalizeCedula('E-84.111.222') === 'E84111222');
check('jurídico J se conserva', normalizeCedula('J-30.123.456') === 'J30123456');
check('gobierno G se conserva', normalizeCedula('G20123456') === 'G20123456');

// --- cédula: E y V del mismo número NO son iguales (no colisionan) ---
check('E y V del mismo número difieren',
  normalizeCedula('E-84.111.222') !== normalizeCedula('V-84.111.222'));

// --- cédula: ceros a la izquierda se descartan ---
check('ceros a la izquierda se quitan', normalizeCedula('V-0123456') === 'V123456');

// --- cédula: entradas inválidas → null ---
check('muy corta → null', normalizeCedula('V-123') === null);
check('demasiados dígitos → null', normalizeCedula('1234567890') === null);
check('sin dígitos → null', normalizeCedula('ABC') === null);
check('vacío → null', normalizeCedula('') === null);
check('null → null', normalizeCedula(null) === null);

// --- nombre: acentos, mayúsculas, puntuación, espacios ---
check('quita acentos y baja a minúsculas',
  normalizeName('José Gabriel Pérez') === 'jose gabriel perez');
check('colapsa espacios y recorta',
  normalizeName('  MARÍA   FERNANDA  ') === 'maria fernanda');
check('puntuación → espacio, dígitos se conservan',
  normalizeName('Ana-Lucía, 22') === 'ana lucia 22');
check('vacío/null → cadena vacía', normalizeName(null) === '' && normalizeName('') === '');

// --- similitud de nombres ---
check('idéntico = 1', nameSimilarity('Jose Perez', 'Jose Perez') === 1);
check('mismo nombre con acentos/caso = 1', nameSimilarity('JOSÉ Pérez', 'jose perez') === 1);
check('tolerante al orden de tokens (alto)',
  nameSimilarity('José Pérez', 'Perez Jose Gabriel') >= 0.5);
check('nombres distintos (bajo)',
  nameSimilarity('Carlos Marín', 'María Rodríguez') < 0.3);
check('cadena vacía → 0', nameSimilarity('', 'algo') === 0);

console.log(`\n${pass} OK, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
