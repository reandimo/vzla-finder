# API pública

Todo endpoint es **GET**, sin auth, y va detrás de un cache (memoria en el origin + Cloudflare en el borde) para absorber tráfico sin pegarle a la base.

## `GET /api/pfif` — feed de federación (PFIF 1.4)

Nuestra data consolidada en el estándar abierto [PFIF 1.4](https://zesty.ca/pfif/1.4/) (People Finder Interchange Format), para que cualquier plataforma pueda federar con nosotros.

| Param | Default | Notas |
|---|---|---|
| `offset` | `0` | desde qué registro |
| `limit` | `200` | máx `500` |

```bash
curl "https://busquedaunificadavzla.com/api/pfif?offset=0&limit=200"
```

- Responde `application/xml`. El comentario de cabecera trae `total`, la página actual y la URL de la **siguiente página**.
- **Sin PII:** NO incluye **cédula** ni datos de contacto — solo lo ya público (nombre, edad, ciudad/estado, foto, estado del caso) + `source_url` de la fuente original.
- **Estado del caso** en `<pfif:note><pfif:status>`: `believed_alive` (localizado), `believed_missing` (sin contacto), `information_sought`.
- **Atribución obligatoria** + opt-out: `opt-out@busquedaunificadavzla.com`.
- Cacheado (`Cache-Control: max-age=120, stale-while-revalidate=600`). Por favor paginá con cortesía.

### ¿Por qué el feed no trae cédula?

Decisión deliberada de privacidad. La cédula sería la mejor llave de federación, pero un volcado masivo, descargable y sin auth de `nombre + documento de identidad + foto + ubicación` de decenas de miles de personas es un riesgo serio de **robo de identidad y fraude** contra víctimas de un desastre, y contradice a las fuentes que ya enmascaran la cédula. Un hash no ayuda: la cédula es un número de ~8 dígitos, reversible por fuerza bruta. Si en el futuro hace falta federar con cédula, la vía sería un **endpoint de socios con API key** y acuerdo de uso, no el feed público.

## `GET /api/search` — búsqueda

```bash
curl "https://busquedaunificadavzla.com/api/search?cedula=V-12.345.678"
curl "https://busquedaunificadavzla.com/api/search?name=jose%20perez"
```

`cedula` = coincidencia exacta (la más precisa). `name` = fuzzy (mín. 2 caracteres). Devuelve JSON `{ count, total, results }` (hasta 200 por nombre; `total` indica si hay más).

Cada resultado incluye, además de los datos de la persona y sus `sources`, los campos de agrupación (ver [Deduplicación y agrupación](Deduplicacion-y-agrupacion.md)):

- `dupGroup` — id del grupo de posibles duplicados (mismo número = posible misma persona), o `null` si es único.
- `dupCount` — cuántos resultados hay en su grupo.

## `GET /api/sources` — fuentes y estado

```bash
curl "https://busquedaunificadavzla.com/api/sources"
```

JSON con las fuentes integradas, su último cacheo y `totalRecords`.

## `POST /api/suggest-source` — sugerir una fuente

Recibe `{ url, name?, note? }`. Lo usa el formulario "Sugerir otra fuente" del landing.
