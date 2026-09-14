---
name: bootstrap
description: Project bootstrapping orchestrator for repos that depend on Vercel-linked resources (databases, auth, and managed integrations). Use when setting up or repairing a repository so linking, environment provisioning, env pulls, and first-run db/dev commands happen in the correct safe order.
---

# Vercel: bootstrap

Project bootstrapping orchestrator for repos that depend on Vercel-linked resources (databases, auth, and managed integrations). Use when setting up or repairing a repository so linking, environment provisioning, env pulls, and first-run db/dev commands happen in the correct safe order.

If this workflow requires an account-backed connector, use the installed app/connector for Vercel. If authorization is missing, ask the user to connect Vercel before taking account actions.
