# Deploy en cPanel / CloudLinux (Node.js Selector)

Esta app puede correr en hosting compartido **cPanel con CloudLinux**, sin root:
la web se sirve por **Phusion Passenger** (Node.js Selector) y la ingesta de
fuentes se dispara por **cron**. No necesita un proceso `node` suelto.

Requisitos del entorno:

- Node **22+** vía el *Node.js Selector* (recomendado 24: `node:sqlite` estable
  sin flag y soporte nativo de TypeScript).
- `cloudlinux-selector` (CLI) para crear/gestionar la app.
- `git`.

> Placeholders: `USUARIO` = tu usuario de cPanel · `RUTA_APP` = carpeta de la app
> (relativa al home) · `DOMINIO` = el (sub)dominio destino · `NODE_BIN` = ruta al
> binario de node del selector (p. ej. `/opt/alt/alt-nodejs24/root/usr/bin/node`).

## 1. Traer el código

```bash
cd ~
git clone https://github.com/reandimo/vzla-finder.git RUTA_APP
cd RUTA_APP
"$NODE_BIN" -e "0"                 # sanity check
# Con node en el PATH para los install-scripts de dependencias:
PATH="$(dirname "$NODE_BIN"):$PATH" npm install --no-audit --no-fund
```

## 2. Base de datos FUERA del docroot (PII)

`data.db` contiene datos personales: **no debe vivir en el docroot web**.

```bash
mkdir -p ~/datos-privados && chmod 700 ~/datos-privados
export VZLA_DB=~/datos-privados/data.db
./scripts/cron-ingest.sh           # primera ingesta; crea la DB
chmod 600 ~/datos-privados/data.db*
```

## 3. Cron de cacheo (cada 15 min)

`runAll()` hace requests condicionales (ETag/hash): si una fuente no cambió, no
re-ingiere. En `crontab -e`:

```cron
*/15 * * * * VZLA_DB=/home/USUARIO/datos-privados/data.db /home/USUARIO/RUTA_APP/scripts/cron-ingest.sh
```

## 4. App web por Passenger

```bash
cloudlinux-selector create --json --interpreter nodejs \
  --user USUARIO --domain DOMINIO \
  --app-root RUTA_APP --app-uri "" \
  --version 24 --app-mode production \
  --startup-file passenger-app.cjs

# Variable de entorno para que la app lea la DB fuera del docroot:
cloudlinux-selector set --json --interpreter nodejs --user USUARIO \
  --app-root RUTA_APP \
  --env-vars '{"VZLA_DB":"/home/USUARIO/datos-privados/data.db","NODE_ENV":"production"}'

cloudlinux-selector restart --json --interpreter nodejs --user USUARIO --app-root RUTA_APP
```

Passenger carga `passenger-app.cjs` (en el repo), que levanta el server
escuchando en el `process.env.PORT` que Passenger asigna.

## 5. Endurecimiento (defensa en profundidad)

Aunque Passenger enruta todo al Node (que solo sirve `public/`), si el proceso
se cae el webserver podría servir archivos crudos. Bloquealos en el `.htaccess`
del docroot:

```apache
RedirectMatch 404 /\.git
RedirectMatch 404 \.(db|sh|cjs)
RedirectMatch 404 ^/(src|test|fixtures|scripts|node_modules|logs)/
```

## Notas

- **PII:** `data.db` no se versiona (`.gitignore`) y vive fuera del docroot.
- **Actualizar:** `git pull && npm install && cloudlinux-selector restart ...`.
- **Logs de ingesta:** `logs/ingest.log` (rota al pasar ~2 MB).
