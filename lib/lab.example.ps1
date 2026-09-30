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

# --- Optional: the planner's and the agents' LLM (default: the researchers') ------------
# $env:PLANNER_LLM_MODEL = ""
# $env:AGENT_LLM_MODEL = ""

# ------------------------------------------------------------------------------------
foreach ($name in @("JEV_KEY", "LLM_KEY", "LLM_MODEL")) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value -like "PUT-*") { Write-Host "Fill in $name in lab.ps1 first."; exit 2 }
}
Set-Location -LiteralPath $PSScriptRoot
node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/lab.ts @args
exit $LASTEXITCODE
