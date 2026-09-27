#!/usr/bin/env bash
# Third-world (cells@1) experiment launcher. Copy to run-cells.sh (git-ignored) and fill in the keys.
#   ./run-cells.sh                       # the experiment, seed 1, level 1, default options
#   ./run-cells.sh --flat                # the CONTROL: a Judge that knows nothing
#   ./run-cells.sh --seed 1 --level 2 --quick
# Every argument is passed through to scripts/run-cells.ts (see its header for the options).

# --- System 1 (Jev) ---------------------------------------------------------------
export JEV_URL="https://api.typesafe.ai/v1/systemone"
export JEV_KEY="PUT-YOUR-JEV-KEY"
# export JEV_MODEL=""                # optional: leave unset to use the service default

# --- System 2 (any OpenAI-compatible chat-completions endpoint) ---------------------
export LLM_URL="PUT-YOUR-OPENAI-COMPATIBLE-URL/chat/completions"
export LLM_KEY="PUT-YOUR-LLM-KEY"
export LLM_MODEL="PUT-YOUR-MODEL"   # e.g. the model you used in the last harness run

# ------------------------------------------------------------------------------------
for v in JEV_KEY LLM_KEY LLM_MODEL; do
  case "${!v}" in PUT-*) if [ "$v" != "JEV_KEY" ] || [[ " $* " != *" --flat "* ]]; then echo "Fill in $v in run-cells.sh first." >&2; exit 2; fi;; esac
done

cd "$(dirname "$0")" || exit 1
exec node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/run-cells.ts "$@"
