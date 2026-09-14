---
name: finding-discovery
description: Use when Codex is already in the finding-discovery phase of a security scan or the user explicitly asks to discover candidate security findings in a repository or code change. Do not use as the primary trigger for full PR, commit, branch, patch, or repository scans.
---

# Codex Security: finding-discovery

Use when Codex is already in the finding-discovery phase of a security scan or the user explicitly asks to discover candidate security findings in a repository or code change. Do not use as the primary trigger for full PR, commit, branch, patch, or repository scans.

If this workflow requires an account-backed connector, use the installed app/connector for Codex Security. If authorization is missing, ask the user to connect Codex Security before taking account actions.
