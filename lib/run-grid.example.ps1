# Unknown-world experiment launcher (Windows PowerShell). Copy to run-grid.ps1 (git-ignored) and fill in the keys.
#   .\run-grid.ps1                       # the experiment, seed 22, default options
#   .\run-grid.ps1 --flat                # the CONTROL: a Judge that knows nothing (should lose)
#   .\run-grid.ps1 --seed 13 --attempts 10 --games 4 --levels 2,4
# Every argument is passed through to scripts/run-grid.ts (--help lists the options).

# --- System 1 (Jev) ---------------------------------------------------------------
$env:JEV_URL = "https://api.typesafe.ai/v1/systemone"
$env:JEV_KEY = "PUT-YOUR-JEV-KEY"
# $env:JEV_MODEL = ""                 # optional: leave unset to use the service default

# --- System 2 (any OpenAI-compatible chat-completions endpoint) ---------------------
$env:LLM_URL = "PUT-YOUR-OPENAI-COMPATIBLE-URL/chat/completions"
$env:LLM_KEY = "PUT-YOUR-LLM-KEY"
$env:LLM_MODEL = "PUT-YOUR-MODEL"   # e.g. the model you used in the last harness run
# Optional, for models that need it (a slow local one, a reasoning one); unset, nothing changes:
# $env:LLM_TIMEOUT_MS = "600000"    # how long to wait for an answer (default 180000)
# $env:LLM_JSON_MODE = "off"        # do not ask for response_format json_object (some servers mishandle it with reasoning models)
# $env:LLM_MAX_TOKENS = "16000"     # max_tokens of an answer (default: the endpoint's; reasoning needs room)
# $env:LLM_TEMPERATURE = "1.0"      # default 0.4; a reasoning model may recommend its own (Qwen3.8: 1.0)
# $env:LLM_EXTRA_BODY = '{"chat_template_kwargs": {"reasoning_effort": "medium"}, "top_p": 0.95, "top_k": 20}'   # fields the endpoint takes besides the standard ones (vLLM)

# ------------------------------------------------------------------------------------
$flat = $args -contains "--flat"
foreach ($name in @("JEV_KEY", "LLM_KEY", "LLM_MODEL")) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value -like "PUT-*" -and -not ($name -eq "JEV_KEY" -and $flat)) {
    Write-Host "Fill in $name in run-grid.ps1 first."
    exit 2
  }
}

Set-Location -LiteralPath $PSScriptRoot
node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/run-grid.ts @args
exit $LASTEXITCODE
