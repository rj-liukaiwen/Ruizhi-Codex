---
name: ruizhi-codex-config-summary
description: Summarize the active Ruizhi Codex configuration from RUIZHI_HOME or the user's .ruizhi directory. Use for model, provider, proxy, authentication callback, marketplace, update, and bridge configuration questions. Read-only and credential-safe.
---

# Ruizhi Codex Configuration Summary

Inspect the active local Ruizhi Codex state and produce a concise report. The default target is `%USERPROFILE%\\.ruizhi` on Windows or `$HOME/.ruizhi` on macOS/Linux. Respect `RUIZHI_HOME` when set.

## Safety

- Read only. Never modify `.ruizhi`, `auth.json`, `config.toml`, caches, rules, or logs.
- Never print API keys, access tokens, refresh tokens, cookies, authorization headers, URL query strings, or full credential values.
- Report credential presence, auth mode, field names, and redacted endpoint origins only.
- Treat `models_cache.json` as the listed-model source and `config.toml` as the active provider/default-model source.
- Do not claim reachability merely because a model is listed; call it listed/configured.
- If a callback or proxy is not explicitly configured, say `not found`.

## Run

```powershell
node .agents/skills/ruizhi-codex-config-summary/scripts/summarize-ruizhi-config.mjs
```

Optional flags: `--home <path>`, `--json`, `--include-env`, and `--include-files`.

The report covers resolved home, provider/base URL, default model, model cache entries, local bridge/proxy, safe proxy environment presence, auth mode and callback/token endpoints, marketplace presence, warnings, and inspected files.