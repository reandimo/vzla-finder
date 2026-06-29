# Tarea diaria de deduplicación con IA (cowork)

Automatiza el ciclo `dump → juzgar → apply` de la capa de IA de vzla-finder, una vez
al día, desde tu PC (siempre encendida). El juez es **Claude Code en modo headless**.
Es una capa de **confianza, nunca fusiona** el dato.

Piezas (en `scripts/`):
- `ai-dedup-daily.ps1` — wrapper que orquesta todo (ssh dump → Claude juzga → ssh apply).
- `ai-dedup-judge.prompt.md` — el prompt con las reglas de juicio.

## Requisitos (una sola vez)
1. **SSH**: el alias `vzla-gce` debe funcionar sin contraseña (`ssh vzla-gce echo ok`).
2. **Claude Code** instalado y autenticado de forma desatendida. Para que corra sin
   sesión interactiva, genera un token de larga vida y guárdalo como variable de
   entorno **del usuario** (no de sesión):
   ```powershell
   claude setup-token        # sigue el flujo, copia el token
   setx ANTHROPIC_API_KEY "<token>"
   ```
   (Verifica con `where claude` que el ejecutable esté en el PATH del usuario.)
3. **Repo** clonado (este). El wrapper usa su propia ruta, no hace falta configurarla.

## Probar a mano primero
```powershell
powershell -ExecutionPolicy Bypass -File C:\Git\personal\vzla-finder\scripts\ai-dedup-daily.ps1
```
La primera vez tras la semilla debería decir **"sin clusters nuevos"** (ya están todos
juzgados). Cuando entren registros nuevos por el cron, juzgará solo esos.
Log y artefactos quedan en `%LOCALAPPDATA%\vzla-ai-dedup\` (`daily.log`, `clusters.json`,
`judgments.json`).

## Programarla (1 vez al día)
Opción A — PowerShell (recomendada). Ajusta la hora (`At`) a tu gusto:
```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"C:\Git\personal\vzla-finder\scripts\ai-dedup-daily.ps1`""
$trigger = New-ScheduledTaskTrigger -Daily -At 4:30am
$set     = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd
Register-ScheduledTask -TaskName "vzla-finder ai-dedup diario" `
  -Action $action -Trigger $trigger -Settings $set -Description "Dedup IA (capa de confianza, nunca fusiona)"
```
- Córrela como **tu usuario** (no SYSTEM) para que vea el `ANTHROPIC_API_KEY` y la
  config de Claude/SSH. En el Programador de tareas: pestaña General → "Ejecutar solo
  cuando el usuario haya iniciado sesión".
- `-StartWhenAvailable` recupera la corrida si la PC estaba apagada a esa hora.

Opción B — GUI (Programador de tareas → Crear tarea básica): desencadenador *Diariamente*,
acción *Iniciar un programa* → `powershell.exe`, argumentos
`-NoProfile -ExecutionPolicy Bypass -File "C:\Git\personal\vzla-finder\scripts\ai-dedup-daily.ps1"`.

## Qué hace cada día
1. `ai-dedup.ts dump --new` en la VM → emite **solo** los clusters con pares sin juzgar.
2. Claude (headless) los juzga con reglas conservadoras (tolera typos/orden de apellidos,
   separa homónimos por edad/zona); si son muchos, reparte en sub-agentes paralelos.
3. `ai-dedup.ts apply` persiste los veredictos (idempotente por `pair_hash`).

Como es incremental, la carga diaria es mínima: la corrida pesada fue la semilla inicial.
