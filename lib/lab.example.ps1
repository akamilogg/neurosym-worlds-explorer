# The `lab` command line (runs, batches, agents, projects) with its keys (Windows PowerShell). Copy to lab.ps1 (git-ignored)
# and fill in the keys. Everything it starts takes them from this environment; they never pass through the command line.
#   .\lab.ps1 list
#   .\lab.ps1 batch examples\batch.example.json
#   .\lab.ps1 project start examples\project.example.json
#   .\lab.ps1 project status cells-levels
#   .\lab.ps1 project approve cells-levels
#   .\lab.ps1 agent last --id coach

# --- System 1 (Jev) ---------------------------------------------------------------
$env:JEV_URL = "https://api.typesafe.ai/v1/systemone"
$env:JEV_KEY = "PUT-YOUR-JEV-KEY"

# --- The researchers' System 2 (any OpenAI-compatible chat-completions endpoint) -----
$env:LLM_URL = "PUT-YOUR-OPENAI-COMPATIBLE-URL/chat/completions"
$env:LLM_KEY = "PUT-YOUR-LLM-KEY"
$env:LLM_MODEL = "PUT-YOUR-MODEL"

# --- Optional: the planner and senior (connection/model default: the researchers') -----
# $env:PLANNER_LLM_MODEL = ""
# $env:SENIOR_LLM_MODEL = ""          # legacy AGENT_LLM_MODEL still works; SENIOR_LLM_MODEL takes precedence
# $env:LLM_REASONING_EFFORT = "low"  # OpenAI: junior (values depend on the model)
# $env:SENIOR_LLM_REASONING_EFFORT = "high" # OpenAI: senior; independent of the junior
# $env:SENIOR_LLM_EXTRA_BODY = '{}'  # optional provider-specific senior fields; never inherits LLM_EXTRA_BODY

# --- Alternative: vLLM/Qwen, without the OpenAI *_REASONING_EFFORT variables ------------
# $env:LLM_EXTRA_BODY = '{"chat_template_kwargs":{"reasoning_effort":"low"},"top_p":0.95,"top_k":20}'
# $env:SENIOR_LLM_EXTRA_BODY = '{"chat_template_kwargs":{"reasoning_effort":"high"},"top_p":0.95,"top_k":20}'
# $env:LLM_TEMPERATURE = "1"
# $env:SENIOR_LLM_TEMPERATURE = "1"  # match sampling to compare only reasoning effort

# ------------------------------------------------------------------------------------
foreach ($name in @("JEV_KEY", "LLM_KEY", "LLM_MODEL")) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value -like "PUT-*") { Write-Host "Fill in $name in lab.ps1 first."; exit 2 }
}
Set-Location -LiteralPath $PSScriptRoot
node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/lab.ts @args
exit $LASTEXITCODE
