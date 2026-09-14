---
name: netlify-edge-functions
description: Guide for writing Netlify Edge Functions. Use when building middleware, geolocation-based logic, request/response manipulation, authentication checks, A/B testing, or any low-latency edge compute. Covers Deno runtime, context.next() middleware pattern, geolocation, and when to choose edge vs serverless.
---

# Netlify: netlify-edge-functions

Guide for writing Netlify Edge Functions. Use when building middleware, geolocation-based logic, request/response manipulation, authentication checks, A/B testing, or any low-latency edge compute. Covers Deno runtime, context.next() middleware pattern, geolocation, and when to choose edge vs serverless.

If this workflow requires an account-backed connector, use the installed app/connector for Netlify. If authorization is missing, ask the user to connect Netlify before taking account actions.
