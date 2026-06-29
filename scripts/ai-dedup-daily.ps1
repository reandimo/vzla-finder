<#
  Tarea DIARIA de deduplicación con IA de vzla-finder (capa de confianza, NUNCA fusiona).
  Orquesta: ssh dump (solo lo nuevo) -> Claude juzga en headless -> ssh apply.

  Cómo programarla: ver scripts/ai-dedup-daily.README.md
  Requisitos: alias ssh `vzla-gce` configurado, Claude Code instalado y autenticado
  (claude setup-token), y este repo clonado. Es idempotente: cada día solo procesa
  los clusters nuevos/cambiados (cacheados por pair_hash en la VM).
#>
$ErrorActionPreference = 'Stop'
$REPO   = Split-Path -Parent $PSScriptRoot          # raíz del repo (working dir de claude)
$PROMPT = Join-Path $PSScriptRoot 'ai-dedup-judge.prompt.md'
$WORK   = Join-Path $env:LOCALAPPDATA 'vzla-ai-dedup'
New-Item -ItemType Directory -Force $WORK | Out-Null
$clusters  = Join-Path $WORK 'clusters.json'
$judgments = Join-Path $WORK 'judgments.json'
$log       = Join-Path $WORK 'daily.log'

function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm')  $m" | Tee-Object -FilePath $log -Append }

$NODE = 'node --experimental-sqlite --experimental-transform-types'
$ENV  = 'VZLA_DB=/opt/vzla/data/data.db'

try {
  # 1) DUMP: solo clusters nuevos/cambiados desde la VM
  $dump = "sudo -u vzla bash -c 'cd /opt/vzla/app && $ENV $NODE scripts/ai-dedup.ts dump --new'"
  ssh vzla-gce $dump | Set-Content -Encoding utf8 $clusters
  $count = (Get-Content $clusters -Raw | ConvertFrom-Json).Count
  if (-not $count) { Log 'sin clusters nuevos -> nada que juzgar'; exit 0 }
  Log "clusters nuevos a juzgar: $count"

  # 2) JUZGAR: Claude headless lee $clusters y escribe $judgments
  Remove-Item $judgments -ErrorAction SilentlyContinue
  $prompt = (Get-Content $PROMPT -Raw).Replace('{{CLUSTERS_JSON}}', $clusters).Replace('{{JUDGMENTS_JSON}}', $judgments)
  Push-Location $REPO
  # --dangerously-skip-permissions: la tarea es desatendida y solo hace Read/Write/Agent
  # locales en una carpeta temporal. Alternativa más estricta (verifica con `claude --help`):
  #   --permission-mode dontAsk --allowedTools "Read,Write,Agent"
  $prompt | claude -p --dangerously-skip-permissions
  Pop-Location
  if (-not (Test-Path $judgments)) { Log 'ERROR: Claude no escribio judgments.json'; exit 1 }

  # 3) APPLY: persistir los veredictos en la VM (idempotente por pair_hash)
  $apply = "sudo -u vzla tee /opt/vzla/data/judgments-daily.json >/dev/null && " +
           "sudo -u vzla bash -c 'cd /opt/vzla/app && $ENV AI_JUDGE_MODEL=manual-claude $NODE scripts/ai-dedup.ts apply /opt/vzla/data/judgments-daily.json'"
  $result = Get-Content $judgments -Raw | ssh vzla-gce $apply
  Log "apply: $result"
}
catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
}
