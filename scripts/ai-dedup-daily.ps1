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
# Escritor UTF-8 SIN BOM: `Set-Content -Encoding utf8` de PS 5.1 antepone un BOM que
# rompe el `JSON.parse` del juez. Forzamos .NET con UTF8Encoding($false).
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

try {
  # 1) DUMP: solo clusters nuevos/cambiados desde la VM.
  #    `2>/dev/null` descarta el ExperimentalWarning de node (stderr) para no ensuciar el JSON.
  #    NO usar `| Set-Content -Encoding utf8` -> mete BOM. Escribimos sin BOM con .NET.
  $dump = "sudo -u vzla bash -c 'cd /opt/vzla/app && $ENV $NODE scripts/ai-dedup.ts dump --new 2>/dev/null'"
  $dumpOut = (ssh vzla-gce $dump | Out-String)
  [System.IO.File]::WriteAllText($clusters, $dumpOut, $Utf8NoBom)
  $count = (($dumpOut -replace '^﻿', '') | ConvertFrom-Json).Count
  if (-not $count) { Log 'sin clusters nuevos -> nada que juzgar'; exit 0 }
  Log "clusters nuevos a juzgar: $count"

  # 2) JUZGAR: Claude headless lee $clusters y escribe $judgments (su Write tool no pone BOM)
  Remove-Item $judgments -ErrorAction SilentlyContinue
  $prompt = (Get-Content $PROMPT -Raw).Replace('{{CLUSTERS_JSON}}', $clusters).Replace('{{JUDGMENTS_JSON}}', $judgments)
  Push-Location $REPO
  # --dangerously-skip-permissions: la tarea es desatendida y solo hace Read/Write/Agent
  # locales en una carpeta temporal. Alternativa más estricta (verifica con `claude --help`):
  #   --permission-mode dontAsk --allowedTools "Read,Write,Agent"
  $prompt | claude -p --dangerously-skip-permissions
  Pop-Location
  if (-not (Test-Path $judgments)) { Log 'ERROR: Claude no escribio judgments.json'; exit 1 }

  # 3) APPLY: persistir los veredictos en la VM (idempotente por pair_hash).
  #    Transferimos con `scp` (bytes intactos). El pipe `Get-Content | ssh ... tee` corrompe
  #    el archivo: PS 5.1 mete BOM y manglea acentos (é -> ??) al pasar texto por stdin,
  #    y el `apply` falla al parsear el JSON.
  scp $judgments vzla-gce:/tmp/judgments-daily.json
  if ($LASTEXITCODE -ne 0) { Log 'ERROR: scp de judgments.json fallo'; exit 1 }
  $apply = "sudo -u vzla cp /tmp/judgments-daily.json /opt/vzla/data/judgments-daily.json && " +
           "sudo -u vzla bash -c 'cd /opt/vzla/app && $ENV AI_JUDGE_MODEL=manual-claude $NODE scripts/ai-dedup.ts apply /opt/vzla/data/judgments-daily.json' && " +
           "rm -f /tmp/judgments-daily.json"
  $result = (ssh vzla-gce $apply | Out-String).Trim()
  Log "apply: $result"
}
catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
}
