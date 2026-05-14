# Bricks

Browser-based IDE that runs Claude (Opus/Sonnet via Azure AI Foundry) against an isolated per-user sandbox. Two front-end modes share the same backend.

## Modes

- Builder: chat interface. User describes what they want; the model edits files and runs commands in the sandbox. A live preview reloads on changes.
- IDE: Monaco editor, xterm.js terminal, file tree, and git, with the model available as a side panel.

## Architecture

Each user is assigned a Kata Containers VM on Azure AKS, pre-installed with Node.js, Python, Go, and Rust. The model reads and writes files, runs shell commands, and operates git inside that sandbox. Two WebSocket connections run in parallel: one to the sandbox (terminal, file events, preview), one for model streaming.

## Stack

Next.js 16, NestJS, Monaco Editor, xterm.js, Drizzle ORM, Azure PostgreSQL, Clerk for auth, Stripe for billing.

## Billing

Free tier includes 100 AI credits per month. Pro is $20/month, Team is $50/seat/month. Credits are consumed per model call with per-model multipliers.

## Status

Design phase. Specs live in this repo across `FRONTEND_ARCHITECTURE.md`, `INFRASTRUCTURE.md`, `SANDBOX-DESIGN.md`, `SECURITY_ARCHITECTURE.md`, `BILLING_SYSTEM_DESIGN.md`, `DATA_LAYER_ARCHITECTURE.md`, `SCHEMA_REFERENCE.md`, and `WEBSOCKET_REALTIME_ARCHITECTURE.md`.
