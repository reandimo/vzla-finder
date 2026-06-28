# Fuentes

Criterio para sumar una fuente, en orden de lo que más importa:

1. **¿Trae cédula?** — es la llave de dedup exacto entre plataformas.
2. **¿API JSON o HTML?** — preferimos JSON; el HTML/SSR se scrapea con `cheerio`.
3. **¿Sin captcha / anti-bot?** — respetamos las protecciones; no se fuerzan.
4. **¿No es espejo de otra fuente?** — evitar doble conteo.

Solo se integran fuentes con datos **reales**: nada de datos sintéticos en producción.

## En vivo en producción

| Plataforma | Endpoint | Cédula | Notas |
|---|---|:---:|---|
| venezuelatebusca.com | API turbo-stream `/_root.data` (React Router) | ✅ | Incremental: páginas más nuevas por corrida. |
| estoyaquive.up.railway.app | API JSON `/api/datos` (FastAPI) | ✅ | Trae **buscadas** (→ sin_contacto) **y** encontradas (→ localizado). Excluye `fallecido`. |
| desaparecidosvenezuela.com | API JSON `/api/personas` | — | Solo los 20 reportes más recientes; trae lat/lng. |
| afectadosporelterremotovenezuela.com | HTML/SSR (desaparecidos · hospitalizados · rescatados) | 🔸 enmascarada | La cédula viene enmascarada → solo pista, nunca merge. `/fallecidos` se excluye. |
| venezuelareporta.org | HTML/SSR `/buscar` paginado | — | UUID estable por ficha; incremental. |
| vzlanos.com | API JSON `/api/personas` paginada | 🔸 enmascarada | estado `sin-contacto`/`localizado`; foto por id. |

## Descartadas / candidatas

- **desaparecidosterremotovenezuela.com** — bloqueada por reCAPTCHA (no se fuerza). En la lista roja del landing.
- **statusvzla.com** — candidata, aún no integrada. En la lista roja.
- **sosvenezuela2026.com** — descartada: es espejo de venezuelatebusca + tiene entradas spam.
- **terremotovenezuela.com** — descartada como fuente de personas: es un mapa de daños de **edificios**.
- **venezuela.tiltely.com** — descartada: es un **directorio** que enlaza otras, no una base propia.
- **Instagram** (cuentas y famosos) — no scrapeable: posts/imágenes sin estructura + login obligatorio.

## Cómo conectar una fuente nueva

1. F12 → **Network → Fetch/XHR** en la plataforma; encuentra el request que devuelve el listado (o el HTML del SSR).
2. Crea `src/sources/<fuente>.ts`. Lo más simple: extender `BaseHttpAdapter` y definir:
   - `url()` — la URL a traer.
   - `parse(body)` — convierte el cuerpo crudo en `RawRecord[]`.
   - Para casos con paginación/varias páginas, sobreescribe `fetchRaw()` (ver `venezuelareporta.ts` o `estoyaqui.ts`).
3. Mapea al `RawRecord`: `sourceId` (estable entre re-scrapes), `sourceUrl` (enlace de vuelta a la ficha), `fullName`, `cedula` (solo si es completa y utilizable — **nunca** una enmascarada), `age`, `status`, `reference`, `photoUrl`.
4. Regístrala en `src/sources/index.ts`.
5. Agrega un test de parseo en `test/adapters.ts` (con un fixture si hace falta).

### Reglas al mapear

- **Cédula enmascarada** (`V-14.XXX.917`, `••••6928`) → **no** va a `cedula` (no es clave de merge). Puede ir como pista en `reference`. Respeta el enmascaramiento de la fuente: nunca intentes completarla.
- **Contactos** (teléfono, email del reportante) → **no** se re-hostean; se enlaza a la fuente.
- **Fallecidos** → se excluyen (el modelo no representa la muerte).
- `sourceId` estable: si la fuente no expone ID por ficha, derívalo de campos de identidad estables (no de campos volátiles como "última actualización").
