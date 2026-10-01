#!/usr/bin/env bash
# Unknown-world experiment launcher. Copy to run-grid.sh (git-ignored) and fill in the keys.
#   ./run-grid.sh                       # the experiment, seed 22, default options
#   ./run-grid.sh --flat                # the CONTROL: a Judge that knows nothing (should lose)
#   ./run-grid.sh --seed 13 --attempts 10 --games 4 --levels 2,4
# Every argument is passed through to scripts/run-grid.ts (--help lists the options).

# --- System 1 (Jev) ---------------------------------------------------------------
export JEV_URL="https://api.typesafe.ai/v1/systemone"
export JEV_KEY="PUT-YOUR-JEV-KEY"
# export JEV_MODEL=""                # optional: leave unset to use the service default

# --- System 2 (any OpenAI-compatible chat-completions endpoint) ---------------------
export LLM_URL="PUT-YOUR-OPENAI-COMPATIBLE-URL/chat/completions"
export LLM_KEY="PUT-YOUR-LLM-KEY"
export LLM_MODEL="PUT-YOUR-MODEL"   # e.g. the model you used in the last harness run
# Optional, for models that need it (a slow local one, a reasoning one); unset, nothing changes:
# export LLM_TIMEOUT_MS=600000      # how long to wait for an answer (default 180000)
# export LLM_JSON_MODE=off          # do not ask for response_format json_object
# export LLM_MAX_TOKENS=16000       # max_tokens of an answer (default: the endpoint's)
# export LLM_TEMPERATURE=1.0        # default 0.4; a reasoning model may recommend its own (Qwen3.8: 1.0)
# export LLM_EXTRA_BODY='{"chat_template_kwargs": {"reasoning_effort": "medium"}, "top_p": 0.95, "top_k": 20}'

# ------------------------------------------------------------------------------------
for v in JEV_KEY LLM_KEY LLM_MODEL; do
  case "${!v}" in PUT-*) if [ "$v" != "JEV_KEY" ] || [[ " $* " != *" --flat "* ]]; then echo "Fill in $v in run-grid.sh first." >&2; exit 2; fi;; esac
done

cd "$(dirname "$0")" || exit 1
exec node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/run-grid.ts "$@"
