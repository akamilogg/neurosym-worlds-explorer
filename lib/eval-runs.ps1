# Evaluation of the unknown-world researcher, phase by phase (EVAL-UNKNOWN-WORLD.md).
# It calls the git-ignored launchers (run-cells.ps1, run-orbit.ps1, run-grid.ps1), which hold the keys: nothing here
# reads or prints a key. Journals go to the repository's runs\eval\<id>.json; a run whose journal already ended is skipped, so a phase
# can be run again after an interruption.
#   .\eval-runs.ps1 -Phase 1          # list what phase 1 would run (nothing is launched)
#   .\eval-runs.ps1 -Phase 1 -Go      # run phase 1, one run after another
param([Parameter(Mandatory = $true)][int]$Phase, [switch]$Go)

$runs = @(
  # --- Phase 1: cells level 3 (second order), replicas and the floor without instruments ------------------------------
  @{ phase = 1; id = 'c3-s1-a';    world = 'cells'; tokens = 400000; args = '--seed 1 --level 3' },
  @{ phase = 1; id = 'c3-s1-b';    world = 'cells'; tokens = 400000; args = '--seed 1 --level 3' },
  @{ phase = 1; id = 'c3-s2-a';    world = 'cells'; tokens = 400000; args = '--seed 2 --level 3' },
  @{ phase = 1; id = 'c3-s2-b';    world = 'cells'; tokens = 400000; args = '--seed 2 --level 3' },
  @{ phase = 1; id = 'c3-s3-a';    world = 'cells'; tokens = 400000; args = '--seed 3 --level 3' },
  @{ phase = 1; id = 'c3-s3-b';    world = 'cells'; tokens = 400000; args = '--seed 3 --level 3' },
  @{ phase = 1; id = 'c3-s1-none'; world = 'cells'; tokens = 400000; args = '--seed 1 --level 3 --tools none' },
  @{ phase = 1; id = 'c3-s2-none'; world = 'cells'; tokens = 400000; args = '--seed 2 --level 3 --tools none' },
  @{ phase = 1; id = 'c3-s3-none'; world = 'cells'; tokens = 400000; args = '--seed 3 --level 3 --tools none' },
  # A real cut and resume: the same as c3-s2-a, stopped early, then resumed (the log answers up to the cut).
  @{ phase = 1; id = 'c3-s2-cut';  world = 'cells'; tokens = 40000;  args = '--seed 2 --level 3' },
  @{ phase = 1; id = 'c3-s2-cut-resumed'; world = 'cells'; tokens = 400000; resume = 'c3-s2-cut' },

  # --- Phase 2: orbit level 1 on other seeds, a replica, the floor; level 3 with the Judge and its flat control --------
  @{ phase = 2; id = 'o1-s3-a';    world = 'orbit'; tokens = 800000; args = '--seed 3 --level 1' },
  @{ phase = 2; id = 'o1-s3-b';    world = 'orbit'; tokens = 800000; args = '--seed 3 --level 1' },
  @{ phase = 2; id = 'o1-s5';      world = 'orbit'; tokens = 800000; args = '--seed 5 --level 1' },
  @{ phase = 2; id = 'o1-s7';      world = 'orbit'; tokens = 800000; args = '--seed 7 --level 1' },
  @{ phase = 2; id = 'o1-s3-none'; world = 'orbit'; tokens = 800000; args = '--seed 3 --level 1 --tools none' },
  @{ phase = 2; id = 'o3-s3';      world = 'orbit'; tokens = 800000; args = '--seed 3 --level 3' },
  @{ phase = 2; id = 'o3-s3-flat'; world = 'orbit'; tokens = 800000; args = '--seed 3 --level 3 --flat' },

  # --- Phase 3: cells level 4 (two layers) with a facet: the task defined, the pure researcher -------------------------
  @{ phase = 3; id = 'c4-s1-even'; world = 'cells'; tokens = 400000; args = '--seed 1 --level 4 --focus even' },
  @{ phase = 3; id = 'c4-s2-even'; world = 'cells'; tokens = 400000; args = '--seed 2 --level 4 --focus even' },
  @{ phase = 3; id = 'c4-s1-all';  world = 'cells'; tokens = 400000; args = '--seed 1 --level 4' },

  # --- Phase 4: the grid, seed 22 (only after deciding the criterion against noise, SPEC-OBJETIVO 9.6) ---------------
  @{ phase = 4; id = 'g22-a';       world = 'grid'; tokens = 1000000; args = '--seed 22' },
  @{ phase = 4; id = 'g22-b';       world = 'grid'; tokens = 1000000; args = '--seed 22' },
  @{ phase = 4; id = 'g22-passive'; world = 'grid'; tokens = 1000000; args = '--seed 22 --tools view,inspect,measure,table' },
  @{ phase = 4; id = 'g22-view';    world = 'grid'; tokens = 1000000; args = '--seed 22 --tools view' },
  @{ phase = 4; id = 'g22-none';    world = 'grid'; tokens = 1000000; args = '--seed 22 --tools none' }
)

Set-Location -LiteralPath $PSScriptRoot
$dir = Join-Path (Split-Path -Parent $PSScriptRoot) 'runs\eval'   # the repository's runs\ (git-ignored)
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function Test-Ended([string]$file) {
  if (-not (Test-Path -LiteralPath $file)) { return $false }
  try { $j = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } catch { return $false }
  return (@($j.events) | Select-Object -Last 1).type -eq 'end'
}

$selected = @($runs | Where-Object { $_.phase -eq $Phase })
if (-not $selected.Count) { Write-Host "No runs in phase $Phase (phases 1 to 4)."; exit 2 }
foreach ($r in $selected) {
  $out = Join-Path $dir ($r.id + '.json')
  if (Test-Ended $out) { Write-Host "skip  $($r.id): its journal already ended"; continue }
  if (Test-Path -LiteralPath $out) { Write-Host "STOP  $($r.id): $out exists but did not end. Resume it (--resume) or delete it, then run the phase again."; exit 1 }
  if ($r.resume) {
    $from = Join-Path $dir ($r.resume + '.json')
    if (-not (Test-Ended $from)) { Write-Host "skip  $($r.id): $($r.resume) has not run yet"; continue }
    $a = @('--resume', $from)
  } else {
    $a = @($r.args -split ' ')
  }
  $a += @('--max-tokens', [string]$r.tokens, '--out', $out)
  Write-Host "$($r.id): .\run-$($r.world).ps1 $($a -join ' ')"
  if ($Go) {
    & ".\run-$($r.world).ps1" @a
    Write-Host "  $($r.id) exited with $LASTEXITCODE"
  }
}
if (-not $Go) { Write-Host "(nothing launched: add -Go to run them)" }
