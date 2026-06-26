/**
 * Punto de entrada para Phusion Passenger / LiteSpeed (Node.js Selector de cPanel).
 *
 * Passenger carga este archivo con Node y espera que la app escuche en el puerto
 * que asigna mediante process.env.PORT. El server real (src/server.ts) ya lo hace.
 *
 * El código es TypeScript con sintaxis que el "strip-only" nativo de Node NO
 * soporta (parameter properties: `constructor(private x = ...)`). Por eso
 * registramos tsx para transformarlo en runtime — igual que en local y en el
 * cron. tsx viene en las dependencias instaladas (npm install).
 */
const { register } = require('tsx/esm/api');
register();

import('./src/server.ts').catch((err) => {
  console.error('No se pudo iniciar la app bajo Passenger:', err);
  process.exit(1);
});
