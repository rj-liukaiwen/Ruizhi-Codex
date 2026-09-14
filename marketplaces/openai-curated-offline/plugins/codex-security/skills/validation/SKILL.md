---
name: validation
description: Use when Codex is already in the validation phase of a security scan or the user explicitly asks to determine whether one or more candidate security findings are valid. Do not use as the primary trigger for full PR, commit, branch, patch, or repository scans.
---

# Codex Security: validation

Use when Codex is already in the validation phase of a security scan or the user explicitly asks to determine whether one or more candidate security findings are valid. Do not use as the primary trigger for full PR, commit, branch, patch, or repository scans.

If this workflow requires an account-backed connector, use the installed app/connector for Codex Security. If authorization is missing, ask the user to connect Codex Security before taking account actions.
