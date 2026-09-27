# Third-world (cells@1) experiment launcher (Windows PowerShell). Copy to run-cells.ps1 (git-ignored) and fill in the keys.
#   .\run-cells.ps1                       # the experiment, seed 1, level 1, default options
#   .\run-cells.ps1 --flat                # the CONTROL: a Judge that knows nothing
#   .\run-cells.ps1 --seed 1 --level 2 --quick
# Every argument is passed through to scripts/run-cells.ts (see its header for the options).

# --- System 1 (Jev) ---------------------------------------------------------------
$env:JEV_URL = "https://api.typesafe.ai/v1/systemone"
$env:JEV_KEY = "PUT-YOUR-JEV-KEY"
# $env:JEV_MODEL = ""                 # optional: leave unset to use the service default

# --- System 2 (any OpenAI-compatible chat-completions endpoint) ---------------------
$env:LLM_URL = "PUT-YOUR-OPENAI-COMPATIBLE-URL/chat/completions"
$env:LLM_KEY = "PUT-YOUR-LLM-KEY"
$env:LLM_MODEL = "PUT-YOUR-MODEL"   # e.g. the model you used in the last harness run

# ------------------------------------------------------------------------------------
$flat = $args -contains "--flat"
foreach ($name in @("JEV_KEY", "LLM_KEY", "LLM_MODEL")) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value -like "PUT-*" -and -not ($name -eq "JEV_KEY" -and $flat)) {
    Write-Host "Fill in $name in run-cells.ps1 first."
    exit 2
  }
}

Set-Location -LiteralPath $PSScriptRoot
node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/run-cells.ts @args
exit $LASTEXITCODE
