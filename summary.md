# Bricks

A web-based platform that brings the full Claude Code experience to the browser. No installation, no terminal knowledge required.

## What It Does

Users describe what they want to build. Claude AI writes the code, runs commands, debugs errors, and deploys — all inside an isolated cloud sandbox. Advanced users get a full browser IDE with terminal, editor, and AI assistant.

## Two Modes

- **Builder Mode**: Chat-first interface for non-technical users. Describe your app, watch it get built. Live preview updates in real time.
- **IDE Mode**: VS Code-like experience for developers. Monaco editor, terminal, file tree, git — with Claude as a pair programmer.

## How It Works

Each user gets an isolated container (Kata VM on Azure AKS) with pre-installed languages (Node.js, Python, Go, Rust). Claude Opus/Sonnet via Azure AI Foundry reads files, writes code, runs commands, and manages git inside the sandbox. Two WebSocket connections keep everything in sync — one for the sandbox, one for AI streaming.

## Tech Stack

Next.js 16, NestJS, Monaco Editor, xterm.js, Drizzle ORM, Azure PostgreSQL, Clerk auth, Stripe billing.

## Business Model

Freemium SaaS. Free tier with 100 AI credits/month. Pro at $20/month, Team at $50/seat/month. Credit-based AI usage with model multipliers.

## Status

Design complete. 18,000+ lines of specs across 12 documents covering frontend, backend, sandbox isolation, AI agent system, security, billing, data layer, and infrastructure. Estimated 25-36 weeks to polished v1.
