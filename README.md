# vzla-finder

Agregador solidario de registros de desaparecidos tras el terremoto de Venezuela (2026).

Hay 4–5 silos ciudadanos creados por separado (venezuelatebusca.com,
desaparecidosterremotovenezuela.com, venezuelareporta.org, terremotovenezuela.com)
que **no cruzan datos entre sí**. Una familia tiene que buscar en cada uno, y los
duplicados y los "ya apareció" sin actualizar se acumulan. Esto unifica la búsqueda
sobre todos, sin re-hostear más datos de los necesarios.

## Qué hace

- **Ingesta** registros públicos de cada silo mediante un *adaptador* por fuente.
- **Normaliza** a un modelo común estilo PFIF (persona + procedencia + notas de estado).
- **Deduplica** en capas: cédula (match exacto, merge seguro entre silos) y, sin
  cédula, nombre + edad ± margen + estado → *sugerencia* para revisión humana.
  **Nunca** fusiona solo.
- **Reconcilia estado**: si cualquier fuente marca "localizado", la buena noticia
  gana, con quién y cuándo lo reportó.
- **Cachea de nuestro lado** y **scrapea en schedule** (default 15 min por fuente),
  con requests condicionales para no re-descargar lo que no cambió.
- **Búsqueda unificada** por cédula o nombre, con links de vuelta a cada fuente.

## Arquitectura de scraping (cada página difiere)

La pieza clave es separar **cómo se trae** de **cómo se parsea**:

- **Fetch (compartido, `src/sources/base.ts`)** — cortesía por host (throttle con
  `minDelayMs`), requests condicionales (`ETag` / `Last-Modified`), timeout y
  `User-Agent` identificable. Esto NO se reescribe por fuente.
- **Parse (por fuente)** — cada adaptador define `parse()` a su manera:
  - `venezuelatebusca.ts` → **JSON** (trae cédula; mejor fuente para dedup).
  - `desaparecidos.ts` → **HTML con cheerio** (scrapea el listado).
  - Casos raros (API con token/POST, paginación, o lista renderizada por JS):
    el adaptador puede sobrescribir `fetchRaw()`. Si la lista es JS-rendered,
    preferí buscar el endpoint JSON que la alimenta antes que Playwright.

Cada fuente declara su `config`: `intervalMinutes`, `minDelayMs`, `jitterMs`.

## Caché del lado nuestro (2 capas)

1. **Snapshot de fuente** (`source_snapshots` en SQLite) — guarda `ETag`,
   `Last-Modified` y un `hash` del contenido por fuente. El runner:
   - manda request condicional → si **304**, no parsea ni re-ingiere;
   - si no hay 304 pero el **hash es igual**, tampoco re-ingiere;
   - si la traída **falla**, conserva el snapshot previo y sigue con el resto.
2. **Query cache** (`src/cache.ts`) — cache en memoria con TTL para las respuestas
   del buscador, para absorber picos de tráfico sin pegarle a la DB en cada tecla.
   Para varias instancias, cambiá esa clase por Redis (misma interfaz). Cloudflare
   adelante es la primera línea; esto es el origin cache.

## Scheduler

`src/scheduler.ts` corre **cada fuente en su propio loop** e intervalo, con:
- **jitter** inicial (no arrancan todas en el mismo segundo),
- **backoff exponencial** ante errores (techo 30 min), para no machacar un sitio caído,
- **aislamiento**: una fuente que falla no frena a las demás.

```bash
npm run watch    # arranca el scheduler (corre indefinidamente)
```

Alternativa: disparar `runAll()` desde un cron del sistema cada 15 min, sin loop propio.

## Correr (Node 22+)

```bash
npm install
npm run demo         # dedup por cédula + reconciliación de estado (8 asserts)
npm run demo:cache   # la 2ª corrida sin cambios NO re-ingiere (4 asserts)
npm run ingest       # corre las fuentes (hoy: fixtures JSON + HTML)
npm run search -- --cedula "V-12.345.678"
npm run search -- --name "carlos marin"
```

> Usa `node:sqlite` (Node 22+). En Node 18/20 cambiá la import de `src/db.ts` por
> `better-sqlite3`; la API (`prepare/run/get/all/exec`) es casi idéntica.

## Conectar una fuente real (5 min)

Hoy corre en modo **fixtures** para no tocar servidores ajenos. En el adaptador:
1. F12 → **Network → Fetch/XHR**, encontrá el request que devuelve los registros.
2. Pegá la URL en `ENDPOINT` y ajustá `parse()` a la forma real.

## Reglas que NO se negocian

- **Sé buen ciudadano.** Pull espaciado y cacheado; los sitios ya se caen por carga.
- **Re-hosteá lo mínimo.** Para el contacto, linkeá a la ficha original.
- **Propagá "localizado" rápido.** Re-scrapeá seguido.
- **Nunca afirmes una coincidencia sin cédula.** Sugerí, no decidas.

## Estructura

```
src/
  types.ts        modelo PFIF-lite + contratos de fuente/caché
  normalize.ts    cédula, nombre, similitud
  db.ts           almacenamiento + snapshots (node:sqlite)
  dedup.ts        resolución de persona
  reconcile.ts    "la buena noticia gana"
  ingest.ts       ingesta de registros (sin red)
  runner.ts       caché + request condicional + ingesta
  scheduler.ts    loops por fuente (intervalo / jitter / backoff)
  cache.ts        query cache (TTL) para el buscador
  search.ts       búsqueda unificada
  cli.ts          CLI (ingest / watch / search)
  sources/
    base.ts            fetch compartido (cortesía + condicional)
    venezuelatebusca.ts  adaptador JSON
    desaparecidos.ts     adaptador HTML (cheerio)
    index.ts             registro de fuentes
test/
  demo.ts         e2e dedup/estado
  cache.ts        e2e caché/skip
fixtures/         datos sintéticos (JSON + HTML)
```
