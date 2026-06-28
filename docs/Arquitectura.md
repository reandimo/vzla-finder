# Arquitectura

vzla-finder es un servicio Node liviano (sin dependencias en runtime salvo `cheerio` para las fuentes HTML): `node:http` + `node:sqlite`. El front es un único `public/index.html` sin build.

## Flujo de datos

```
Plataformas ciudadanas
   │  (un adaptador por fuente: JSON o HTML)
   ▼
Ingesta ──► Normalización (modelo PFIF-lite)
   │
   ▼
Deduplicación ──► cédula = merge exacto · sin cédula = registro aparte
   │
   ▼
Reconciliación de estado (la buena noticia gana)
   │
   ▼
API de búsqueda + cache  ──►  Agrupación visual "posible duplicado"  ──►  Buscador web
```

## Módulos (`src/`)

| Archivo | Rol |
|---|---|
| `types.ts` | Modelo PFIF-lite (`RawRecord`, `PersonRecord`, `SourceLink`, `NoteRecord`…) y contratos de fuente/caché. |
| `normalize.ts` | Cédula (`V-`/`E-`), nombre (sin acentos, minúsculas) y similitud (Levenshtein/Jaccard). |
| `db.ts` | Almacenamiento + snapshots sobre `node:sqlite` (WAL). Búsqueda por tokens de nombre. |
| `dedup.ts` | Resolución de persona: merge por cédula; sin cédula, fallback por silo (no fusiona entre plataformas). |
| `reconcile.ts` | Consolida el estado de una persona: "localizado" de cualquier fuente gana, guardando quién/cuándo. |
| `ingest.ts` / `runner.ts` | Ingesta + caché con request condicional (`ETag`/`Last-Modified`/hash). |
| `scheduler.ts` | Loops por fuente (intervalo / jitter / backoff). |
| `cache.ts` | Query cache (TTL) para el buscador. |
| `search.ts` | Búsqueda unificada por cédula y por nombre + etiqueta de "posible duplicado". |
| `server.ts` | Servidor HTTP: API (`/api/search`, `/api/sources`, `/api/pfif`, `/api/suggest-source`) + estático. |
| `pfif.ts` | Serializador PFIF 1.4 (feed público, sin PII). |
| `cli.ts` | CLI: `ingest` / `watch` / `search`. |
| `sources/` | Un adaptador por plataforma + base de fetch cortés (`base.ts`). |

## Modelo de datos (PFIF-lite)

- **PersonRecord** — identidad canónica (cédula normalizada, nombre, edad, género, última zona/referencia, foto).
- **SourceLink** — procedencia: en qué fuente y con qué `sourceId` está reportada esa persona (una persona puede estar en varios silos).
- **NoteRecord** — actualizaciones de **estado** atadas a la persona y a la fuente. No se sobreescribe la persona: se agregan notas, así "localizado" nunca pisa el historial.

Regla central: **el dato no se fusiona a ciegas.** Cédula = match exacto. Sin cédula = registro aparte (ver [Deduplicación y agrupación](Deduplicacion-y-agrupacion.md)).

## Runtime y despliegue

- Node 24 ejecutando TypeScript con el **transform nativo** (`--experimental-transform-types`, sin esbuild).
- Corre en una VM de Google Cloud detrás de **Caddy** (HTTPS) + **Cloudflare** (proxy/edge cache). El servidor como `systemd service`; la ingesta como `systemd timer` horario. La DB con PII vive fuera del docroot.
