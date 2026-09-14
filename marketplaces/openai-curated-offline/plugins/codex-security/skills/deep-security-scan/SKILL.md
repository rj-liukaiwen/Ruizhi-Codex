---
name: deep-security-scan
description: Use when the user asks for a deep, exhaustive, multi-pass, or variance-reducing repository-wide or scoped-path Codex Security scan. Run repeated independent discovery passes over one resolved scope with worker-specific threat models, semantically merge candidates, synthesize one canonical validation threat model, then run validation, attack-path analysis, canonical JSON completion, and generated reporting once. Do not use for PRs, commits, branch diffs, or working-tree diffs.
---

# Codex Security: deep-security-scan

Use when the user asks for a deep, exhaustive, multi-pass, or variance-reducing repository-wide or scoped-path Codex Security scan. Run repeated independent discovery passes over one resolved scope with worker-specific threat models, semantically merge candidates, synthesize one canonical validation threat model, then run validation, attack-path analysis, canonical JSON completion, and generated reporting once. Do not use for PRs, commits, branch diffs, or working-tree diffs.

If this workflow requires an account-backed connector, use the installed app/connector for Codex Security. If authorization is missing, ask the user to connect Codex Security before taking account actions.
