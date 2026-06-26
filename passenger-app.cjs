/**
 * Punto de entrada para Phusion Passenger (cPanel / CloudLinux Node.js Selector).
 *
 * Passenger carga este archivo con Node y espera que la app escuche en el
 * puerto que asigna mediante process.env.PORT. Node 24 ejecuta TypeScript de
 * forma nativa, así que sólo importamos el server real (src/server.ts), que ya
 * escucha en process.env.PORT (default 3000 en local).
 *
 * Si una versión de Node sin soporte nativo de TS tuviera que correr esto,
 * descomentar el registro de tsx (requiere la devDependency instalada):
 *
 *   const { register } = require('tsx/esm/api');
 *   register();
 */
import('./src/server.ts').catch((err) => {
  console.error('No se pudo iniciar la app bajo Passenger:', err);
  process.exit(1);
});
