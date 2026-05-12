# Fixtures (reserved)

This directory is reserved for recorded LLM responses, raw IG webhook
payloads, and other data files needed by personas that don't live in
the persona TypeScript itself.

v1 doesn't record anything — the dae-script persona makes real LLM
calls against `api.anthropic.com`. When a future persona needs a
deterministic replay (e.g. a flaky model decision), record the response
JSON here and reference it from the persona file.
