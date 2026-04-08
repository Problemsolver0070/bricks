# Bricks - Web IDE / Cloud Coding Platform Research

> Last updated: 2026-04-08 (MVP Build Research Added)

## MVP Build Research (2026-04-08)

### Azure AI Foundry SDK (for Claude Opus)
- **Package**: `@anthropic-ai/foundry-sdk` + `@azure/identity`
- **Endpoint**: `https://{resource}.services.ai.azure.com/anthropic/v1/messages`
- **Auth**: API key or Azure AD (DefaultAzureCredential)
- **Model**: `claude-opus-4-6`
- **Streaming**: `stream: true` or `.stream()` method

### WebContainers
- **Package**: `@webcontainer/api` v1.6.1
- **COEP**: `credentialless` alternative avoids breaking third-party embeds
- **Single instance**: `boot()` once per page, `teardown()` before re-boot

### PayPal Subscriptions
- **Package**: `@paypal/react-paypal-js` (V5 SDK: PayPalScriptProvider + PayPalButtons)
- **Known issue**: ~8% CANCELLED events missed — need reconciliation
- **Sandbox verification**: Webhook postback does NOT work for simulated events

---

---

## 1. Web-Based Code Editors

### Monaco Editor (by Microsoft)
- **What**: The editor powering VS Code, extracted as a standalone library
- **Bundle size**: Large (5-10MB uncompressed)
- **Strengths**: Richest out-of-the-box features (IntelliSense, error checking, find/replace, minimap, multi-cursor). Best accessibility (ARIA, screen readers). Strong LSP integration. Excellent large-file performance (100k+ lines via viewport-aware tokenization)
- **Weaknesses**: Limited customization compared to CodeMirror. Large bundle. Moderate mobile support
- **npm downloads**: ~2.43M/week (March 2025)

### CodeMirror 6 (by Marijn Haverbeke)
- **What**: Complete rewrite of CodeMirror, modular architecture
- **Bundle size**: ~300KB core (tree-shakeable, modular)
- **Strengths**: Best mobile support (70% better retention than Ace on Replit). Highly extensible plugin/extension system. Lezer-based incremental parsing. Excellent for CRDT-based collaboration (Y.js bindings). Smallest footprint
- **Weaknesses**: Minimal out-of-box features (requires assembly). Basic accessibility (extensible). More initial configuration needed
- **npm downloads**: ~3.47M/week (March 2025) -- most popular
- **Used by**: Replit (migrated from Ace), Val Town, many modern editors

### Ace Editor
- **What**: Original cloud IDE editor (from Cloud9)
- **Status**: Maintenance mode, increasingly behind CodeMirror 6 and Monaco
- **Weaknesses**: Weakest mobile support. Lags on very large files. Regex-based tokenization lacks precision

### Recommendation
- **For a full IDE experience**: Monaco Editor -- closest to VS Code, best IntelliSense
- **For flexibility/mobile/collab**: CodeMirror 6 -- smaller, more extensible, better CRDT support
- **Avoid**: Ace for new projects (legacy)

---

## 2. Web Terminal Emulators

### xterm.js -- The De Facto Standard
- **What**: Front-end TypeScript component for fully-featured terminals in the browser
- **License**: MIT
- **Features**: GPU-accelerated rendering, rich Unicode, screen reader accessibility, links, theming, addons, zero dependencies
- **Used by**: VS Code, Hyper, Azure Cloud Shell, Replit, Codecademy, CoCalc, Linode, Proxmox VE, ttyd
- **Status**: Actively maintained (2026), no real competitor in the browser-based JS terminal space
- **Fork**: xterm.es (ES module fork)

### Connecting to Backend
- xterm.js handles rendering only -- needs a backend PTY process
- **node-pty**: Spawns child processes for terminal interaction in Node.js
- **Transport**: WebSocket between xterm.js frontend and node-pty backend
- **Pattern**: Each keystroke transferred via WebSocket to backend PTY, response streamed back

### Emerging: libghostty
- Written in Zig by Ghostty creator, could eventually challenge xterm.js for embedded terminal use
- Provides a high-quality native terminal core embeddable via C API
- Not browser-ready yet, but worth watching

### Recommendation
- **Use xterm.js** -- no viable alternative for browser-based terminals. Battle-tested, massive adoption

---

## 3. Cloud Sandbox / Container Orchestration

### Isolation Technologies (Ranked by Security)

#### Firecracker MicroVMs (Gold Standard)
- Created by AWS for Lambda and Fargate
- **Boot time**: 125ms cold, 28ms from snapshots
- **Memory overhead**: <5 MiB per microVM
- **Density**: Up to 150 microVMs/second/host
- **Security**: Hardware virtualization (Intel VT-x/AMD-V), ~83K lines of Rust. VM escape requires hypervisor CVE ($250K-$500K bounty class)
- **Limitations**: No GPU passthrough, no nested virtualization, no CPU hotplugging (by design)
- **Best for**: Short-lived sandboxes, AI agent execution, serverless functions

#### Cloud Hypervisor (Swiss Army Knife MicroVM)
- Keeps minimal spirit but adds: nested KVM, VFIO device passthrough (GPUs), CPU/memory hotplugging, Windows guest support
- Better for general-purpose cloud workloads that need GPU or nested virt

#### gVisor (Google)
- Intercepts syscalls in user space -- stronger than containers but not a dedicated kernel
- Used by Modal for AI agent sandboxes

#### Sysbox
- Enhanced container runtime providing VM-like isolation without a hypervisor
- Used by Daytona as optional stronger isolation layer

#### Standard Docker Containers
- Weakest isolation (shared kernel, container escapes are real -- multiple CVEs in 2024-2025)
- Fastest cold starts, most developer-friendly
- Fine for development; risky for untrusted code execution without additional isolation

### Managed Sandbox Platforms

| Platform | Isolation | Cold Start | Key Feature |
|----------|-----------|------------|-------------|
| **E2B** | Firecracker | ~150ms | Open source (Apache-2.0), AI agent sandboxes |
| **Daytona** | Docker (default) + Kata optional | Sub-90ms | Fastest cold starts, LSP support, stateful |
| **Northflank** | Kata Containers (Firecracker-grade) | Seconds | Managed, low ops burden |
| **Modal** | gVisor | Fast | Serverless compute, Python-focused |
| **Gitpod** | Ephemeral VMs | Fast | Rebranded as AI agent platform (Sep 2025), SOC 2 |

### Azure-Specific Options

#### Azure Container Apps (ACA)
- Serverless containers, runs on managed AKS underneath
- Scale to zero, pay-per-use ($0.40/million requests)
- Free tier: 180K vCPU-seconds, 360K GiB-seconds, 2M requests/month
- **Best for**: Event-driven, microservices, background processing without Kubernetes expertise
- **Limitation**: No direct Kubernetes API access, Linux only

#### Azure Kubernetes Service (AKS)
- Full managed Kubernetes with direct API access
- Supports Windows + Linux containers, advanced networking, hybrid/multi-cloud
- AKS Automatic mode reduces operational overhead
- **Best for**: Complex orchestration needs, multi-tenant platforms, teams with K8s expertise

#### Azure Container Instances (ACI)
- Simplest option -- single container, no orchestration
- Good for quick bursts or simple isolation needs

### Three-Layer Sandboxing Architecture
1. **Primitives**: Firecracker, gVisor, Cloud Hypervisor, LiteBox
2. **Embeddable Runtimes/APIs**: E2B, microsandbox (wrap primitives into SDKs)
3. **Managed Platforms**: Modal, Northflank, Daytona (handle orchestration + scaling)

### Recommendation
- **For untrusted code execution**: Firecracker microVMs (via E2B or self-managed)
- **For development environments**: Docker containers with optional Sysbox/Kata for hardening
- **For Azure deployment**: Start with Azure Container Apps for simplicity; graduate to AKS if you need full control
- **Key insight**: "The hardest problem in sandboxing isn't virtualization -- it's data movement." Pre-baked snapshots and block-level caching are essential for sub-second starts

---

## 4. Real-Time Collaboration

### Y.js (CRDT-based) -- Recommended
- **What**: Most popular CRDT implementation for collaborative apps (900K+ weekly downloads)
- **Architecture**: Decentralized, no central server required. Edits work offline and sync later
- **Performance**: Fastest CRDT implementation available
- **Network**: Agnostic -- WebSocket, WebRTC, P2P all supported
- **Editor bindings**: CodeMirror, ProseMirror, Quill, Monaco, TipTap
- **Persistence**: MongoDB, PostgreSQL, IndexedDB, S3
- **Features**: Shared types (Text, Map, Array, XML), Awareness CRDT (cursors/presence), undo/redo, version snapshots
- **Used by**: Tiptap, Excalidraw, and many production collaborative editors

### ShareDB (OT-based)
- **What**: Operational Transformation based, requires central server
- **Architecture**: Server-authoritative, primarily WebSocket-based
- **Strengths**: Simpler model if you already have a central server
- **Weaknesses**: Limited offline support, server-dependent scaling, narrower editor bindings (mainly Quill)

### Key Differences

| Aspect | Y.js (CRDT) | ShareDB (OT) |
|--------|-------------|--------------|
| Central server | Not required | Required |
| Offline support | Built-in | Limited |
| P2P capable | Yes | No |
| Editor bindings | Broad | Narrow (Quill-focused) |
| Scalability | Peer-to-peer | Server-dependent |

### Recommendation
- **Use Y.js** for any new collaborative editor project. It's the industry standard for CRDTs, works with both Monaco and CodeMirror, supports offline-first, and scales better than OT approaches

---

## 5. AI-Powered Coding Platforms -- Competitive Landscape

### Market Overview (2026)
- AI coding tools market: ~$12.8B (up from $5.1B in 2024)
- 85% of developers regularly use AI coding tools
- 25% of YC W2025 startups had 95% AI-generated codebases

### Two Categories

#### AI Code Editors (Developer-facing IDEs)

| Platform | Architecture | Key Differentiator |
|----------|-------------|-------------------|
| **Cursor** | VS Code fork, AI-native | Agent mode, multi-file edits, multi-model (OpenAI + Anthropic) |
| **Windsurf** | AI IDE with "Cascade" agent | Acquired by OpenAI for $3B (May 2025). Highest production-ready code quality (8.5/10). Model-agnostic, BYOK |
| **GitHub Copilot** | VS Code extension + agent | Deepest GitHub integration, workspace agents |
| **Claude Code** | Terminal-based agent | Complex codebase navigation, agentic workflows |

#### AI App Builders (Browser-based, Low/No-Code)

| Platform | Architecture | Key Metric |
|----------|-------------|-----------|
| **Lovable** | Chat-to-app, Supabase backend | $200M ARR, $6.6B valuation. Fastest-growing startup ever (potentially). Bi-directional GitHub sync |
| **Bolt.new** | StackBlitz WebContainers (client-side Node.js in browser) | Fastest to prototype (28 min). Not for production |
| **Replit** | Cloud IDE + AI Agent + hosting (50+ languages) | Revenue $10M to $100M in 9 months. Richest ecosystem |
| **v0.dev** | Vercel's React/Next.js component builder | Least lock-in (exports standard React). Best code quality (9/10) |

### Key Patterns That Work
1. **Agentic workflows**: Multi-step planning, tool use, iterative refinement
2. **Multi-tool stacks**: Lovable for prototype, Cursor for production
3. **AI as platform**: Moving from "AI inside IDE" to "AI as development platform"
4. **Security concerns**: VibeScamming vulnerability in Lovable (April 2025) -- AI-generated code exposed to prompt injection. Not ready for regulated industries without review

### Tech Stacks Used
- **Cursor**: Electron (VS Code fork), TypeScript, multi-model API integration
- **Replit**: Custom cloud IDE, Nix for environments, GCP infrastructure, AI Agent for full-stack generation
- **Bolt.new**: StackBlitz WebContainers (WASM-based Node.js in browser), Netlify deployment
- **Lovable**: React frontend, Supabase backend, Anthropic + OpenAI models, GitHub integration
- **v0.dev**: Next.js, shadcn/ui, Tailwind CSS, Vercel deployment
- **GitHub Codespaces**: Azure VMs, Docker containers, devcontainer.json, VS Code (browser/desktop), WebSocket/RPC

---

## 6. Claude API via Azure AI Foundry (Microsoft Foundry)

### Overview
- Claude models (Opus 4.6, Sonnet 4.6, Haiku 4.5) available in Microsoft Foundry
- Serverless deployment -- Anthropic manages infrastructure
- Billed through Microsoft Marketplace with Azure subscription at Anthropic standard pricing

### SDK Support
- Supported: C#, Java, PHP, Python, TypeScript
- Not supported: Go, Ruby
- API responses follow standard Anthropic API format (usage object consistent across all platforms)

### Authentication
- **API Key**: Standard approach
- **Microsoft Entra ID**: Enhanced security with Azure RBAC, integrates with org identity management

### Context Windows
- Claude Opus 4.6 / Sonnet 4.6: **1M tokens** on Foundry
- Other models (Sonnet 4.5, etc.): 200K tokens

### Supported Features
- Code execution tool, web search/fetch, citations, vision, tool use, prompt caching

### Environment Variables (for Claude Code integration)
```bash
CLAUDE_CODE_USE_FOUNDRY=1
ANTHROPIC_FOUNDRY_RESOURCE=<your-resource-name>
ANTHROPIC_DEFAULT_OPUS_MODEL='claude-opus-4-6'
ANTHROPIC_DEFAULT_SONNET_MODEL='claude-sonnet-4-6'
```

### Gotchas
- Model Router (2025-11-18) does NOT support claude-sonnet-4-6 or claude-opus-4-6 -- deploy directly
- If you use model aliases (sonnet, opus) without pinning, Claude Code may attempt newer versions not available in your account
- .NET/MEAI integration: official MEAI does not yet have built-in Foundry support (Claude API format differs from OpenAI)
- Claude runs on Anthropic's infrastructure (commercial integration for billing through Azure)
- Monitoring via standard Azure patterns (Monitor, Log Analytics, Cost Management)

---

## 7. File System Sync (Browser <-> Cloud Sandbox)

### Architecture Pattern
```
Browser (Monaco/CodeMirror) <--WebSocket/JSON-RPC--> Cloud Container (Docker/VM)
                                                      |-- Language Server (LSP)
                                                      |-- File System (with watchers)
                                                      |-- Terminal (node-pty)
```

### File Sync Approaches

#### WebSocket + File Watchers (Most Common)
- **Chokidar** watches file system changes in the container
- Changes (create/modify/delete) pushed to frontend via WebSocket events
- Frontend editor sends file save/create/delete operations back via WebSocket
- **Used by**: CodeSandbox-style IDEs, Eclipse Theia

#### LSP over WebSocket
- **Val Town's vtlsp**: CodeMirror LSP client + LSP proxy + WebSocket server
- Language servers run in cloud container, communicate via WebSocket to browser
- Supports multicasting (multiple browsers connected to same language server)
- Some language servers (e.g., Deno) require physical files on disk

#### Eclipse Theia Architecture
- Client-server application: frontend sends requests via WebSocket, backend executes
- Kubernetes pattern: User -> Ingress -> Service -> Pod -> WebSocket established
- Persistent Volume Claims (PVC) for file storage across pod restarts

### Key Principles
- **LSP is transport-agnostic**: Server can run locally or in cloud
- **1:1 mapping**: One language server per user (cannot share across users)
- **File watchers are essential**: Terminal changes must propagate to frontend
- **Latency matters**: WebSocket preferred over HTTP polling for real-time feel

### Tools & Libraries
- **Chokidar**: File system watcher for Node.js
- **node-pty**: Pseudo-terminal for Node.js
- **monaco-languageclient** (TypeFox): Monaco + LSP over WebSocket
- **vtlsp** (Val Town): CodeMirror + LSP over WebSocket to cloud containers
- **webfuse**: WebSocket filesystem based on libfuse

### Recommendation
- WebSocket for all real-time communication (file sync, terminal, LSP)
- Chokidar for server-side file watching
- Debounce file sync events to avoid flooding
- Use binary protocols (not JSON) for large file transfers
- Consider operational transforms or CRDT for collaborative file editing

---

## 8. Authentication & Billing

### Authentication

#### Clerk -- Recommended for Modern SaaS
- **Best for**: Next.js / React applications
- **Pricing**: Free (50K MRU), Pro $20/mo (50K MRU included), then $0.02/MRU
- **Features**: Pre-built UI components, Organizations (multi-tenancy), server middleware, Entra ID/SAML SSO
- **Security**: SOC2 Type II, HIPAA, GDPR, CCPA
- **Stripe integration**: Official zero-integration billing with Clerk + Stripe (Stripe Sessions 2025)
- **Latest**: Core 3 (March 2026) -- unified `<Show>` component, redesigned auth hooks

#### Auth0 -- Enterprise Grade
- **Best for**: Enterprise compliance, complex auth pipelines
- **Pricing**: B2B Essentials $150/mo (500 MAU, 3 SSO connections), Professional $800/mo (1K MAU, 5 SSO)
- **Warning**: "Growth penalty" -- SSO connection limits force expensive upgrades. One company: 15.54x bill increase after 1.67x user growth
- **Strengths**: Most extensible, broadest SDK coverage

#### Better Auth -- Rising Open Source Contender
- Framework-agnostic, v1.0 stable with plugin architecture
- OAuth, 2FA, passkeys, organizations
- Database adapters via Drizzle or Prisma
- Growing in T3-stack boilerplates

#### Other Options
- **WorkOS**: 1M free MAU, passkeys on every plan -- excellent for B2B
- **Supabase Auth**: Open source, self-hostable
- **AWS Cognito**: Cheapest at scale for AWS-invested teams

### Billing

#### Stripe -- The Standard
- Dominant billing platform for SaaS
- Deep Clerk integration (zero-integration billing)
- Supports subscriptions, usage-based billing, invoicing, tax calculation
- Stripe Connect for marketplace/platform billing

### Recommendation
- **Clerk + Stripe** for modern SaaS (best DX, native integration)
- **Auth0** only if enterprise SSO/compliance is day-one requirement
- **Better Auth** if you need self-hosted/open-source auth

---

## 9. Frontend Frameworks

### Next.js 15/16 -- The Safe Bet
- **Latest**: Next.js 16 -- Turbopack stable for production builds, Partial Prerendering (PPR) toward GA
- **Strengths**: Largest ecosystem (6.5M weekly downloads), most React packages, easiest hiring, server components, server actions, ISR, middleware
- **Weaknesses**: Larger bundle than SvelteKit, complexity of App Router, some Vercel lock-in concerns
- **Best for**: Enterprise/scale hiring, complex full-stack apps, teams already on React

### SvelteKit (Svelte 5 + Runes)
- **Latest**: Svelte 5 runes system
- **Strengths**: Smallest JS footprint (~7KB vs ~89KB for Next.js on simple pages), best performance (LCP, TBT), 90% developer satisfaction (vs 83% React), compile-time optimization
- **Weaknesses**: Smaller ecosystem (~500K weekly downloads), fewer component libraries, harder to hire
- **Best for**: Small/medium teams prioritizing performance and DX

### Remix -> React Router v7
- **Latest**: Merged into React Router v7, Remix 3 in development (batteries-included, bundler-free)
- **Strengths**: Web standards (FormData, fetch, Response), progressive enhancement, excellent for data-heavy apps
- **Best for**: Internal tools, admin panels, multi-step workflows, data-entry-heavy apps

### Recommendation
- **Next.js** for the web IDE project -- largest ecosystem, best React integration, most components available, easiest to hire for. The complexity of an IDE project benefits from React's massive library ecosystem

---

## 10. Backend Frameworks

### Node.js (NestJS / Fastify)
- **Strengths**: Same language as frontend (TypeScript full-stack), excellent WebSocket ecosystem (Socket.IO, ws), fastest development velocity, massive npm ecosystem
- **Best frameworks**: NestJS (structured, Angular-inspired, built-in WebSocket/GraphQL), Fastify (performance-focused)
- **Weaknesses**: Single-threaded (CPU-bound tasks block event loop), not ideal for >100K RPS compute-heavy workloads
- **Best for**: 90% of web development use cases, rapid iteration, full-stack TypeScript teams

### Go (Gin / Fiber)
- **Strengths**: Goroutines for massive concurrency, single binary deployment, excellent for microservices, Kubernetes/cloud-native ecosystem (Docker, K8s, Terraform all in Go)
- **Performance**: Handles millions of WebSocket connections efficiently
- **Weaknesses**: Less expressive than TypeScript, smaller web framework ecosystem
- **Best for**: Container orchestration services, high-concurrency WebSocket servers, infrastructure tooling
- **Used by**: Uber (dispatch, pricing, matching), Docker, Kubernetes

### Rust (Axum / Actix-web)
- **Strengths**: 2-3x faster than Go, 5-10x faster than Node.js. Zero-cost abstractions, no GC pauses, lowest cloud bills
- **Best frameworks**: Axum (Tokio team, gaining momentum), Actix-web (battle-tested, actor model)
- **Weaknesses**: Steep learning curve, smaller ecosystem, slowest development velocity
- **Best for**: Performance-critical components, infrastructure primitives

### Elixir/Phoenix -- Honorable Mention
- Built for massive concurrency and real-time (millions of WebSocket connections)
- LiveView for real-time UI without heavy JS frameworks
- Best for messaging platforms, live dashboards

### Recommendation for Web IDE Platform
- **Primary backend**: Node.js (NestJS) -- TypeScript full-stack, excellent WebSocket support, fastest iteration
- **Container orchestration / sandbox management**: Go -- perfect for infrastructure services, container lifecycle management
- **Performance-critical paths**: Consider Rust for specific hot paths if needed later

---

## Architecture Summary: Recommended Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Code Editor** | Monaco Editor | Closest to VS Code, best IntelliSense, rich features OOTB |
| **Terminal** | xterm.js | No alternative, industry standard |
| **Frontend Framework** | Next.js 15/16 | Largest ecosystem, React compatibility, SSR |
| **Backend (API/WebSocket)** | Node.js + NestJS | TypeScript full-stack, WebSocket-native, fastest iteration |
| **Backend (Orchestration)** | Go | Container lifecycle, infrastructure services |
| **Sandbox Isolation** | Firecracker microVMs (via E2B or self-managed) | Best security for untrusted code. Docker for dev environments |
| **Cloud Platform** | Azure Container Apps -> AKS | Start simple, graduate to K8s when needed |
| **Real-time Collaboration** | Y.js (CRDT) | Industry standard, works with Monaco, offline-first |
| **File Sync** | WebSocket + Chokidar | Real-time bidirectional sync |
| **LSP** | LSP over WebSocket | Language intelligence in cloud containers |
| **AI Backend** | Claude via Azure AI Foundry | 1M token context, Azure billing, Anthropic infrastructure |
| **Authentication** | Clerk | Best Next.js integration, SOC2, built-in Stripe billing |
| **Billing** | Stripe | Industry standard, native Clerk integration |
| **Collaboration** | Y.js + WebSocket | CRDT-based, no central server needed |

---

## Key References & Sources

### Code Editors
- [Replit: Comparing Code Editors](https://blog.replit.com/code-editors)
- [CodeMirror vs Monaco: Comprehensive Comparison](https://agenthicks.com/research/codemirror-vs-monaco-editor-comparison)
- [npm trends: ace vs codemirror vs monaco](https://npmtrends.com/ace-code-editor-vs-codemirror-vs-monaco-editor)

### Terminal Emulators
- [xterm.js Official](https://xtermjs.org/)
- [State of Terminal Emulators 2025](https://www.jeffquast.com/post/state-of-terminal-emulation-2025/)

### Cloud Sandboxes
- [MicroVM Isolation in 2026](https://emirb.github.io/blog/microvm-2026/)
- [Firecracker vs Docker Technical Boundary](https://huggingface.co/blog/agentbox-master/firecracker-vs-docker-tech-boundary)
- [Sandboxes that Boot in 28ms](https://dev.to/adwitiya/how-i-built-sandboxes-that-boot-in-28ms-using-firecracker-snapshots-i0k)
- [AI Agent Sandboxing Guide 2026](https://manveerc.substack.com/p/ai-agent-sandboxing-guide)
- [Open-Source Alternatives to E2B](https://www.beam.cloud/blog/best-e2b-alternatives)
- [Northflank: Secure Runtime for Codegen](https://northflank.com/blog/secure-runtime-for-codegen-tools-microvms-sandboxing-and-execution-at-scale)
- [Azure Container Apps vs AKS 2026 Decision Guide](https://developersvoice.com/blog/azure/azure_container_apps_vs_aks_framework/)

### Real-Time Collaboration
- [Y.js Homepage](https://yjs.dev/)
- [Y.js GitHub](https://github.com/yjs/yjs)
- [Best CRDT Libraries 2025](https://velt.dev/blog/best-crdt-libraries-real-time-data-sync)

### AI Platforms
- [2026 AI Coding Platform Wars](https://medium.com/@aftab001x/the-2026-ai-coding-platform-wars-replit-vs-windsurf-vs-bolt-new-f908b9f76325)
- [AI Dev Tool Power Rankings March 2026](https://blog.logrocket.com/ai-dev-tool-power-rankings/)
- [Best Vibe Coding Tools 2026](https://lovable.dev/guides/best-vibe-coding-tools-2026-build-apps-chatting)

### Claude on Azure
- [Claude in Microsoft Foundry - Anthropic Docs](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry)
- [Deploy Claude in Microsoft Foundry - MS Learn](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude)
- [Anthropic Announcement](https://www.anthropic.com/news/claude-in-microsoft-foundry)

### File System & LSP
- [How to Build a Web IDE](https://dev.to/abdddd/how-to-build-a-web-ide-like-codesandbox-38e6)
- [Val Town vtlsp](https://github.com/val-town/vtlsp)
- [Eclipse Theia Cloud IDE Guide](https://www.codehall.in/understanding-eclipse-theia-a-developers-guide-to-cloud-ides/)
- [LSP Official](https://microsoft.github.io/language-server-protocol/)

### Authentication & Billing
- [Clerk + Stripe Zero-Integration Billing](https://stripe.com/sessions/2025/instant-zero-integration-saas-billing-with-clerk-stripe)
- [Better Auth vs Clerk vs NextAuth 2026](https://starterpick.com/blog/better-auth-clerk-nextauth-saas-showdown-2026)
- [Clerk vs Auth0 for Next.js](https://clerk.com/articles/clerk-vs-auth0-for-nextjs)

### Stripe Billing & Usage Metering (2026)
- [Stripe Usage-Based Billing Docs](https://docs.stripe.com/billing/subscriptions/usage-based)
- [Stripe Meters API Reference](https://docs.stripe.com/api/billing/meter)
- [Stripe Meter Events API](https://docs.stripe.com/api/billing/meter-event)
- [Stripe AI Startup Usage-Based Billing Guide](https://docs.stripe.com/get-started/use-cases/usage-based-billing)
- [Stripe Metered Billing Guide for SaaS 2026](https://www.buildmvpfast.com/blog/stripe-metered-billing-implementation-guide-saas-2026)
- [Stripe Webhook Handling for Subscriptions](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe Tax for EU VAT](https://docs.stripe.com/tax/supported-countries/european-union)
- [EU VAT ViDA 2026 Compliance](https://www.creem.io/blog/eu-vat-vida-2026-saas-compliance-guide)

### AI Billing & Credit Systems
- [AI Billing Software Platforms 2026 (Solvimon)](https://www.solvimon.com/blog/6-ai-billing-software-platforms-built-for-credits)
- [SaaS Credits System Guide 2026](https://colorwhistle.com/saas-credits-system-guide/)
- [Stripe + SaaS Credits Integration Guide](https://colorwhistle.com/stripe-saas-credits-billing/)
- [Credit-Based Pricing Software for AI (Flexprice)](https://flexprice.io/blog/best-credit-based-pricing-software-for-ai-companies)

### Claude API Pricing (April 2026)
- [Official Claude API Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Claude API Pricing Breakdown 2026](https://www.metacto.com/blogs/anthropic-api-pricing-a-full-breakdown-of-costs-and-integration)
- Opus 4.6: $5/MTok in, $25/MTok out
- Sonnet 4.6: $3/MTok in, $15/MTok out
- Haiku 4.5: $1/MTok in, $5/MTok out
- Output tokens are 5x input cost across all models
- Batch API: 50% discount, Prompt Caching: up to 90% savings

### Anti-Abuse & Fraud Prevention
- [SaaS Free-Tier Abuse Prevention (TrustedAccounts)](https://www.trustedaccounts.org/industry/saas)
- [Free Trial Abuse Prevention Strategies](https://payproglobal.com/how-to/prevent-free-trial-abuse/)
- [ASN Reputation for SaaS Fraud Prevention](https://greip.io/blog/Beyond-the-IP-How-SaaS-Companies-Can-Use-ASN-Reputation-to-Proactively-Block-HighRisk-Traffic-and-Prevent-Trial-Abuse-326)
- [SaaS Fraud Detection Strategies](https://www.nected.ai/blog/saas-fraud-detection)

### Clerk Billing (2026)
- [Clerk Billing Overview](https://clerk.com/docs/guides/billing/overview)
- [Clerk Billing for B2C SaaS](https://clerk.com/docs/nextjs/guides/billing/for-b2c)
- Limitation: Clerk Billing does NOT support usage-based/metered billing natively (as of early 2026)
- Limitation: Clerk Billing does not support tax/VAT yet
- Limitation: Clerk Billing does not support refunds (must use Stripe directly)
- Recommendation: Use Clerk for auth + Stripe Billing directly for usage-based billing (not Clerk Billing)

### Frontend Frameworks
- [Next.js vs Remix vs SvelteKit 2026](https://www.nxcode.io/resources/news/nextjs-vs-remix-vs-sveltekit-2025-comparison)
- [Definitive Framework Decision Guide 2026](https://dev.to/pockit_tools/nextjs-vs-remix-vs-astro-vs-sveltekit-in-2026-the-definitive-framework-decision-guide-lp5)

### Backend Frameworks
- [Node.js vs Go vs Rust Backend Performance](https://devproportal.com/languages/nodejs/node-vs-go-vs-rust-backend-performance/)
- [Rust vs Go 2026](https://tech-insider.org/rust-vs-go-2026/)
- [Top Backend Frameworks 2026](https://roadmap.sh/backend/frameworks)

### GitHub Codespaces Architecture
- [Deep Dive into Codespaces](https://docs.github.com/en/codespaces/about-codespaces/deep-dive)
- [GitHub Codespaces in 2026](https://medium.com/@ion.stefanache0/beyond-the-code-the-deterministic-magic-of-github-codespaces-in-2026-ebb2a7fdcc20)

---

## 11. Frontend Architecture Research (2026-04-08)

### Next.js 16 (Released Oct 2025, latest 16.2 March 2026)
- **Turbopack**: Stable and default for `next dev` and `next build`. 5-10x faster Fast Refresh, 2-5x faster builds
- **React 19.2**: View Transitions, `useEffectEvent()`, `<Activity/>` component (background render with `display: none` while maintaining state)
- **React Compiler 1.0**: Stable in Next.js 16, auto-memoization of components (opt-in via `reactCompiler` config)
- **`"use cache"` directive**: Explicit opt-in caching for pages/components/functions. `cacheLife` and `cacheTag` stable
- **Layout deduplication**: Prefetching shared layouts downloaded once instead of per-link
- **Build Adapters API**: Stable in 16.2 -- custom deployment platform adapters
- **16.2 AI features**: Agent-ready `create-next-app`, Browser Log Forwarding, Agent DevTools (experimental)
- **Breaking**: AMP removed, `next lint` removed (use Biome/ESLint directly)
- Source: [Next.js 16 Blog](https://nextjs.org/blog/next-16), [Next.js 16.2](https://nextjs.org/blog/next-16-2)

### shadcn/ui (Latest: April 2026)
- **Resizable component**: Built on `react-resizable-panels` v4, exports `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle`
- **Sidebar component**: VS Code-like resizing, cookie-persisted state, collapsible, mobile drawer fallback
- **March 2026 - CLI v4**: `init --preset` for quick reconfiguration, `shadcn/skills` for AI agent context
- **February 2026**: Unified `radix-ui` package (single import instead of `@radix-ui/react-*`), RTL support
- **April 2026**: Component Composition patterns
- Source: [shadcn/ui Changelog](https://ui.shadcn.com/docs/changelog), [Resizable Docs](https://ui.shadcn.com/docs/components/radix/resizable)

### react-resizable-panels v4 (Latest: 4.9.0)
- **Layout persistence**: `autoSaveId` prop for localStorage, custom `storage` prop for cookies/DB
- **SSR-compatible**: Cookie-based persistence to avoid layout flicker
- **Nested groups**: PanelGroup inside Panel for complex IDE grid layouts
- **Conditional panels**: Separate layout persistence per panel combination
- **Collapsible panels**: Auto-collapse below half `minSize`, configurable `collapsedSize`
- **All sizing percentage-based** (no pixel constraints by design)
- Source: [react-resizable-panels GitHub](https://github.com/bvaughn/react-resizable-panels)

### Zustand v5 (State Management)
- Built on `useSyncExternalStore` for React 18/19 concurrent mode safety
- **Slice pattern**: Recommended for large apps -- modular stores co-located near features
- **`useShallow`**: Performance hook for selecting multiple values without unnecessary re-renders
- **Middleware**: `persist` (localStorage/AsyncStorage), `devtools`, `immer`
- **Best practice**: Separate client state (Zustand) from server state (React Query/SWR)
- **Named exports only** in v5 for better tree-shaking
- Source: [Zustand v5 Guide](https://dev.to/vishwark/mastering-zustand-the-modern-react-state-manager-v4-v5-guide-8mm)

### monaco-languageclient (Latest: v10.7.0, Feb 2026)
- **Unified package**: v10 merged `monaco-editor-wrapper` into `monaco-languageclient`
- **WebSocket LSP**: Uses `vscode-ws-jsonrpc` for JSON-RPC over WebSocket to cloud language servers
- **React component**: `@typefox/monaco-editor-react` v7.7.0 wraps all functionality
- **Architecture**: Browser MonacoLanguageClient -> WebSocket -> vscode-ws-jsonrpc -> Language Server in sandbox
- **Multiple transports**: WebSocket (external), Web Worker (in-browser), MessagePort
- **VS Code API compatibility**: Via `@codingame/monaco-vscode-api` (now `monaco-vscode-api` v26)
- Source: [monaco-languageclient GitHub](https://github.com/TypeFox/monaco-languageclient)

### xterm.js (Latest: @xterm/xterm)
- **Scoped packages**: All addons now under `@xterm/` scope (e.g., `@xterm/addon-webgl`)
- **13 official addons**: fit, webgl, search, web-links, clipboard, image, serialize, unicode11, ligatures
- **WebGL renderer** (`@xterm/addon-webgl` v0.19.0): GPU-accelerated, texture atlas caching, handles context loss
- **DOM renderer**: Significantly faster in recent updates, default fallback
- **Smooth scrolling**: Now affects all scroll methods
- **`rescaleOverlappingGlyphs`**: Opt-in for GPU-accelerated modes
- Source: [xterm.js GitHub](https://github.com/xtermjs/xterm.js), [xterm.js Docs](https://xtermjs.org/)

---

## 12. WebSocket & Real-Time Communication Research (2026-04-08)

> Full architecture document: See `WEBSOCKET_REALTIME_ARCHITECTURE.md`

### Key Decisions Made
- **2 WebSocket connections per user**: Sandbox (terminal/files/LSP) + Core API (AI/project mgmt) -- independent failure domains
- **Raw WebSocket over Socket.IO**: Full protocol control, no unnecessary abstraction
- **JSON-RPC 2.0 + binary frames**: LSP-native protocol with binary escape hatch for terminal I/O
- **Go reverse proxy (sandbox-router) + Redis**: Session-to-pod routing with dynamic lookup
- **Sequence-based replay + full sync fallback**: Reconnection without losing state
- **Last-writer-wins with conflict detection**: For single-user file sync (CRDTs reserved for future multi-user collab)

### Key Research References
- [WebSocket Architecture Best Practices (Ably)](https://ably.com/topic/websocket-architecture-best-practices)
- [WebSockets at Scale: Architecture for Millions](https://websocket.org/guides/websockets-at-scale/)
- [WebSocket Reconnection: State Sync Guide](https://websocket.org/guides/reconnection/)
- [WebSockets vs HTTP for AI (Ably)](https://ably.com/blog/websockets-vs-http-for-ai-streaming-and-agents)
- [NGINX WebSocket Performance](https://www.f5.com/company/blog/nginx/nginx-websockets-performance)
- [Kubernetes WebSocket Ingress](https://websocket.org/guides/infrastructure/kubernetes/)
- [Gateway API v1.4](https://kubernetes.io/blog/2025/11/06/gateway-api-v1-4/)
- [Streaming Architecture 2026: SSE vs WebSockets vs RSC](https://jetbi.com/blog/streaming-architecture-2026-beyond-websockets)
- [CRDT Filesync (Tonsky)](https://tonsky.me/blog/crdt-filesync/)
- [monaco-languageclient v10.7](https://github.com/TypeFox/monaco-languageclient)

---

## 13. AI Agent System Design Research (2026-04-08)

> Full architecture document: See `AI_AGENT_SYSTEM_DESIGN.md`

### Claude API -- Messages Format & Tool Use
- **Messages API**: POST /v1/messages with `messages[]`, `tools[]`, `system`, `max_tokens`, `stream`
- **Content block types**: `text`, `tool_use`, `tool_result`, `thinking`, `redacted_thinking`, `server_tool_use`, `image`, `document`
- **Stop reasons**: `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, `refusal`, `pause_turn`
- **Streaming events**: `message_start`, `content_block_start`, `content_block_delta` (text_delta, input_json_delta, thinking_delta), `content_block_stop`, `message_delta`, `message_stop`
- **Tool categories**: User-defined (client-executed), Anthropic-schema (client-executed: bash, text_editor, computer, memory), Server-executed (web_search, web_fetch, code_execution, tool_search)
- **Agentic loop**: While `stop_reason == "tool_use"`: execute tools -> format `tool_result` blocks -> send back -> repeat
- Source: [Tool Use Overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview), [Messages API](https://platform.claude.com/docs/en/api/messages)

### Claude Agent SDK
- **5 message types**: SystemMessage (init, compact_boundary), AssistantMessage, UserMessage, StreamEvent, ResultMessage
- **Built-in tools**: Read, Edit, Write, Glob, Grep, Bash, WebSearch, WebFetch, ToolSearch, Agent, Skill, AskUserQuestion, TodoWrite
- **Control options**: max_turns, max_budget_usd, effort (low/medium/high/max), permission_mode (default/acceptEdits/plan/dontAsk/auto/bypassPermissions)
- **Parallel execution**: Read-only tools run concurrently; mutating tools run sequentially
- **Result subtypes**: success, error_max_turns, error_max_budget_usd, error_during_execution, error_max_structured_output_retries
- Source: [Agent Loop](https://platform.claude.com/docs/en/agent-sdk/agent-loop)

### Claude Code Architecture (Leaked/Public)
- **Single-threaded master loop**: One message array + while loop, no multi-agent orchestration
- **Streaming-first**: SSE with tool calls detected mid-stream
- **QueryEngine.ts**: 46K-line core handling all LLM API calls, streaming, caching, orchestration
- **Tool system**: ~40 modular tools in plugin architecture, each with schema + permission level + execution logic
- **Context compaction**: Auto-triggers when approaching context limit, summarizes older messages
- **Sub-agents**: AgentTool spawns nested loops with fresh context, only final result returns
- Source: [How Claude Code Works](https://code.claude.com/docs/en/how-claude-code-works), [Architecture Deep Dive](https://dev.to/brooks_wilson_36fbefbbae4/claude-code-architecture-explained-agent-loop-tool-system-and-permission-model-rust-rewrite-41b2)

### Pricing (April 2026)
- **Opus 4.6**: $5/MTok input, $25/MTok output, $6.25/MTok cache write (5m), $0.50/MTok cache read
- **Sonnet 4.6**: $3/MTok input, $15/MTok output, $3.75/MTok cache write (5m), $0.30/MTok cache read
- **Haiku 4.5**: $1/MTok input, $5/MTok output, $1.25/MTok cache write (5m), $0.10/MTok cache read
- **Cache hit = 0.1x base input price** (90% savings on repeated content)
- **Batch API**: 50% discount on all models
- **Fast mode (Opus 4.6)**: 6x standard rates ($30/$150 per MTok)
- **Web search**: $10 per 1,000 searches + token costs
- **Tool use overhead**: 346 tokens system prompt per request (with tools)
- Source: [Claude Pricing](https://platform.claude.com/docs/en/about-claude/pricing)

### Context Window Management
- **1M tokens**: Opus 4.6 and Sonnet 4.6 on Azure AI Foundry (standard pricing, no surcharge)
- **Context awareness**: Models receive `<budget:token_budget>` and per-turn `<system_warning>` with remaining tokens
- **Server-side compaction**: Beta for Opus 4.6 / Sonnet 4.6 -- summarizes older context
- **Context editing**: Tool result clearing, thinking block clearing
- **Extended thinking**: Previous thinking blocks auto-stripped from context (don't accumulate)
- **Prompt caching**: 5-minute (1.25x write, 0.1x read) and 1-hour (2x write, 0.1x read) durations
- Source: [Context Windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)

### Azure AI Foundry Rate Limits
- **Quota**: Per subscription, per region, per model in TPM (tokens per minute)
- **Default**: ~50 RPM, ~200K ITPM (varies by model/subscription)
- **Cache-aware**: Cached input tokens do NOT count toward ITPM limits
- **Quota increases**: Supported for Anthropic models via Azure portal
- **Automatic tiers**: Quotas increase automatically with usage (new feature)
- Source: [Foundry Models Quotas](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/quotas-limits), [Claude in Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry)

### Key Design References
- [How Tool Use Works](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works)
- [Define Tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
- [Agent SDK Agent Loop](https://platform.claude.com/docs/en/agent-sdk/agent-loop)
- [Claude Code Architecture](https://dev.to/oldeucryptoboi/inside-claude-codes-architecture-the-agentic-loop-that-codes-for-you-cmk)
- [Claude Code Architecture (Rust Rewrite)](https://dev.to/brooks_wilson_36fbefbbae4/claude-code-architecture-explained-agent-loop-tool-system-and-permission-model-rust-rewrite-41b2)
- [Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Writing Tools for Agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Cost Optimization for Azure AI Foundry Claude](https://chandanbhagat.com.np/cost-optimization-strategies-for-azure-ai-foundry/)

---

## 14. Security Architecture Research (2026-04-08)

> Full architecture document: See `SECURITY_ARCHITECTURE.md`

### Key Decisions Made
- **Authentication**: Clerk (not Azure AD B2C -- sunset May 2025 for new customers). 60-second JWT lifetime, HttpOnly cookies, SameSite=Lax, automatic CSRF protection
- **Container runtime**: Kata Containers on AKS (officially supported, hardware-level VM isolation, separate kernel per pod). gVisor as cost-optimized fallback for free-tier
- **Secret management**: Azure Key Vault with Workload Identity + Secrets Store CSI Driver. Zero static credentials in cluster
- **Network policy engine**: Cilium (Azure CNI). eBPF-based, robust IMDS blocking, Azure NPM being deprecated Sep 2026 (Linux) / Sep 2028 (Windows)
- **DNS for sandboxes**: External only (8.8.8.8/8.8.4.4), no cluster DNS resolution to prevent service discovery attacks
- **Pod security**: Restricted PSS profile, custom seccomp (allowlist approach), custom AppArmor profile, all capabilities dropped, non-root UID 1000, read-only root filesystem
- **AI security**: Defense-in-depth for prompt injection (sandboxing + permission gating + input/output validation + isolated context windows). Cannot be fully prevented -- focus on containment

### Critical Security Findings
1. **Azure AD B2C is sunset** -- Microsoft ended sales to new customers May 1, 2025. Migrating to Entra External ID. Do NOT build on B2C for new projects
2. **Standard NetworkPolicy cannot reliably block IMDS** (169.254.169.254) on AKS -- must use AKS native `--enable-imds-restriction` AND Cilium policies
3. **Next.js CVE-2025-29927** (CVSS 9.1) -- middleware bypass via `x-middleware-subrequest` header. Must block this header at edge/proxy
4. **Claude CVE-2025-54794 & CVE-2025-54795** -- prompt injection escape in Claude Code during research preview. Highlights risk of LLM-powered developer tools
5. **Kubernetes Secrets are base64-encoded, NOT encrypted** by default -- etcd access = secret access. Must use Azure Key Vault + CSI Driver instead
6. **Azure NPM deprecated** -- Sep 2026 (Windows), Sep 2028 (Linux). Migrate to Cilium or Calico now

### Key Research References
- [AKS Pod Sandboxing](https://azure-samples.github.io/aks-labs/docs/security/pod-sandboxing-on-aks/)
- [Kubernetes Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [Sandboxing AI Agents in 2026](https://northflank.com/blog/how-to-sandbox-ai-agents)
- [Kubernetes Agent Sandbox SIG](https://github.com/kubernetes-sigs/agent-sandbox)
- [gVisor on AKS](https://www.danielstechblog.io/running-gvisor-on-azure-kubernetes-service-for-sandboxing-containers/)
- [Seccomp vs AppArmor](https://www.rack2cloud.com/seccomp-vs-apparmor-container-breakout/)
- [Block IMDS on AKS](https://learn.microsoft.com/en-us/azure/aks/imds-restriction)
- [IMDS Restriction with Cilium on AKS](https://www.danielstechblog.io/restrict-access-to-the-imds-endpoint-on-azure-kubernetes-service-with-cilium/)
- [AKS Network Policy Best Practices](https://learn.microsoft.com/en-us/azure/aks/network-policy-best-practices)
- [Clerk Cookies & Tokens](https://clerk.com/docs/guides/how-clerk-works/cookies)
- [Clerk Tokens and Signatures](https://clerk.com/docs/guides/how-clerk-works/tokens-and-signatures)
- [Azure AD B2C End of Sale](https://envisionit.com/resources/articles/microsoft-to-end-sale-of-azure-ad-b2bb2c-on-may-1-2025-shifting-to-entra-id-external-identities)
- [Azure Key Vault with Kubernetes](https://devtron.ai/blog/how-to-manage-secrets-with-azure-key-vault-in-kubernetes/)
- [Anthropic: Mitigate Prompt Injections](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks)
- [Anthropic: Prompt Injection Defenses](https://www.anthropic.com/research/prompt-injection-defenses)
- [OWASP: LLM Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
- [NestJS Security Best Practices](https://dev.to/drbenzene/best-security-implementation-practices-in-nestjs-a-comprehensive-guide-2p88)
- [WebSocket Security Guide](https://websocket.org/guides/security/)

---

## 15. Data Layer Architecture Research (2026-04-08)

> Full architecture documents: See `DATA_LAYER_ARCHITECTURE.md` and `schema.sql`

### Azure PostgreSQL Multi-Tenancy
- **Three isolation models**: Shared schema + RLS, Schema-per-tenant, Database-per-tenant
- **Chosen: Shared schema + RLS** -- cost-effective for 1000s of tenants, 1-5% query overhead
- **PostgreSQL RLS**: `SET LOCAL bricks.current_org_id` per transaction, policies check `current_setting()`
- **Schema-per-tenant degrades** pg_catalog performance beyond ~5,000 schemas -- avoid
- **Azure Flexible Server `session_variable` extension**: Manages tenant context in sessions
- Source: [Azure Multi-Tenant PostgreSQL](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/postgresql), [Multi-Tenant SaaS Isolation Guide](https://www.sachith.co.uk/multi%E2%80%91tenant-saas-data-isolation-scaling-strategies-practical-guide-mar-23-2026/)

### Azure Blob Storage
- **Block blobs** for all file storage (parallel upload, cost-effective)
- **Tiered storage**: Hot (active), Cool (30+ days), Archive (90+ days) with lifecycle policies
- **Do NOT use blob versioning** for IDE auto-save (cost explosion) -- use explicit snapshots
- **GRS** (Geo-Redundant) for critical data, LRS for snapshots/exports
- **GPv1 retirement**: October 2026 -- use GPv2 only
- Source: [Azure Blob Storage Best Practices](https://learn.microsoft.com/en-us/azure/well-architected/service-guides/azure-blob-storage)

### Azure Managed Redis (replaces Azure Cache for Redis)
- **Azure Cache for Redis retiring**: Enterprise (March 2028), Basic/Standard/Premium (Sep 2028)
- **Azure Managed Redis**: GA, built in partnership with Redis, production-ready globally
- **WebSocket scaling**: Redis pub/sub as backplane for multi-instance WebSocket servers
- **Scaling strategy**: Scale OUT (clustering/sharding) preferred over scale UP
- Source: [Azure Managed Redis](https://azure.microsoft.com/en-us/products/managed-redis), [Redis Scaling Best Practices](https://learn.microsoft.com/en-us/azure/azure-cache-for-redis/cache-best-practices-scale)

### Connection Pooling (PgBouncer)
- **Built-in PgBouncer** on Azure Flexible Server (no separate deployment needed)
- **Transaction mode** (default): Best for web workloads
- **Formula**: `(number_of_pools x default_pool_size) < max_connections - 15`
- **PgBouncer 1.25.1**: Handles up to 10,000 connections with async I/O
- Source: [PgBouncer Best Practices Azure](https://techcommunity.microsoft.com/blog/adforpostgresql/pgbouncer-best-practices-in-azure-database-for-postgresql-%E2%80%93-part-1/4453323)

### ORM: Drizzle Kit (over Prisma)
- **Drizzle surpassed Prisma** in weekly npm downloads (late 2025)
- **Zero binary dependencies**: 7KB runtime vs 40KB+ for Prisma
- **Code-first schema**: Schema IS the TypeScript code
- **NEVER use `db push` in production** -- both ORMs warn against this
- **Neither auto-creates FK indexes** -- must add manually
- Source: [Drizzle vs Prisma 2026](https://makerkit.dev/blog/tutorials/drizzle-vs-prisma), [Definitive ORM Comparison 2026](https://tech-insider.org/drizzle-vs-prisma-2026/)

### Backup & Recovery
- **Azure automated backups**: Up to 35 days retention, zone-redundant, encrypted (AES-256)
- **PITR RPO**: Up to 5 minutes (same-region), up to 1 hour (geo-redundant)
- **RTO**: Minutes to hours depending on database size and WAL volume
- Source: [Azure PostgreSQL Backup & Restore](https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore)

### GDPR & Soft Deletes
- **EDPB February 2026 CEF report**: Erasure compliance now in regulators' crosshairs
- **Soft delete alone is NOT GDPR-compliant** -- must pair with hard-delete purge pipeline
- **Best practice**: Soft delete -> 30-day grace period -> automated hard delete
- **Partial indexes**: `WHERE deleted_at IS NULL` for unique constraints on soft-deleted tables
- **Billing records**: Retained 7 years (legal requirement) with anonymized personal data
- Source: [PostgreSQL Soft Deletes 2026](https://oneuptime.com/blog/post/2026-01-21-postgresql-soft-deletes/view), [GDPR Deletion & Backups](https://www.probackup.io/blog/gdpr-and-backups-how-to-handle-deletion-requests)

### Conversation Storage
- **Hybrid storage**: Small messages (< 4KB) in PostgreSQL, large payloads in Blob Storage
- **PostgreSQL + Redis**: Industry-standard for chat applications (2026)
- **Tree structure for branching**: `parent_message_id` enables conversation forking
- **Token counting per message**: `input_tokens`, `output_tokens`, `cached_tokens`, `cost_microcents`
- Source: [Stateful Conversations with Postgres](https://medium.com/@levi_stringer/building-stateful-conversations-with-postgres-and-llms-e6bb2a5ff73e), [Chat App Schema Design](https://www.tome01.com/efficient-schema-design-for-a-chat-app-using-postgresql)

---

## 16. Sandbox System Deep Dive Research (2026-04-08)

> Full architecture document: See `SANDBOX-DESIGN.md`

### AKS Pod Sandboxing with Kata Containers
- **Kata on AKS**: Native support via `--workload-runtime KataVmIsolation` on node pools
- **Requires**: Azure Linux os-sku, Gen2 VMs with nested virtualization (e.g., Dsv3, D8s_v5)
- **Hypervisor**: Cloud Hypervisor (not QEMU like upstream Kata)
- **Isolation**: Each pod gets its own lightweight VM, own kernel, hardware-enforced isolation
- **Limitations**: Microsoft Defender doesn't assess Kata pods, no host-network access
- Source: [AKS Pod Sandboxing](https://learn.microsoft.com/en-us/azure/aks/use-pod-sandboxing)
- Source: [Kata on AKS Setup](https://oneuptime.com/blog/post/2026-02-16-how-to-set-up-aks-with-kata-containers-for-hardware-isolated-pod-sandboxing/view)
- Source: [Kata on AKS Blog](https://www.danielstechblog.io/using-kata-containers-on-azure-kubernetes-service-for-sandboxing-containers/)

### Kubernetes Agent Sandbox (kubernetes-sigs)
- **CNCF project** under SIG Apps, launched KubeCon NA 2025
- **CRDs**: Sandbox, SandboxTemplate, SandboxClaim
- **Features**: Warm pools, lifecycle management (scale-to-zero + resume), stable identity, persistent storage
- **Isolation backends**: gVisor (default) and Kata Containers
- **Replaces**: Manual StatefulSet(1) + headless Service + PVC pattern
- **Observability**: Creation latency metrics, OpenTelemetry tracing, warm pool efficiency
- **Roadmap 2026-2027**: Firecracker/QEMU support, Ray/CrewAI integration
- Source: [Agent Sandbox GitHub](https://github.com/kubernetes-sigs/agent-sandbox)
- Source: [Agent Sandbox Official](https://agent-sandbox.sigs.k8s.io/)
- Source: [Running Agents on Kubernetes](https://kubernetes.io/blog/2026/03/20/running-agents-on-kubernetes-with-agent-sandbox/)
- Source: [Agent Sandbox on Kubernetes (Northflank)](https://northflank.com/blog/agent-sandbox-on-kubernetes)

### AKS Autoscaling at Scale
- **Cluster Autoscaler**: Checks Metrics API every 10 seconds, only considers memory/CPU requests (not usage)
- **NAP (Node Auto-Provisioner)**: Karpenter-based, dynamically provisions right-sized VMs, better bin-packing
- **Resource fragmentation**: CPU pressure doesn't trigger scale-up (unlike memory), pods starved indefinitely
- **PVC zonal constraints**: Azure Disk PVCs are zone-locked, must match node zone
- **AKS Automatic**: Managed system pools (preview), Microsoft handles system node lifecycle
- **Spot VM support**: Priority expander for cost optimization, 60-90% savings with eviction risk
- **Limits**: Single AKS cluster tested to 5,000 nodes / 150,000 pods
- Source: [AKS Cluster Autoscaler](https://learn.microsoft.com/en-us/azure/aks/cluster-autoscaler)
- Source: [NAP Best Practices](https://blog.aks.azure.com/2026/03/20/node-provisioning-best-practice)
- Source: [Spot Pools on AKS](https://blog.aks.azure.com/2025/07/17/Scaling-safely-with-spot-on-aks)

### Azure Disk Snapshots & Volume Lifecycle
- **VolumeSnapshot CRD**: Standard K8s API, states: Creating -> ReadyToUse -> Restoring/Deleting
- **Restore**: Create new PVC with snapshot as dataSource, must be >= original size
- **Azure Disk snapshots**: Incremental (only changed blocks), fast creation (<5s)
- **Restore time**: 10-30 seconds (lazy load)
- **Snapshot cost**: ~$0.05/GB/month
- Source: [Azure Container Storage Snapshots](https://learn.microsoft.com/en-us/azure/storage/container-storage/volume-snapshot-restore)
- Source: [Kubernetes Volume Snapshot Restore](https://oneuptime.com/blog/post/2026-02-20-kubernetes-volume-snapshot-restore/view)

### BlobFuse v2 (Azure Blob FUSE Mount)
- **FUSE-based**: Translates filesystem calls to Azure Blob REST APIs
- **Modes**: Caching (download full file to local cache) and Streaming (chunk-based reads)
- **POSIX limitations**: Rename not atomic (breaks npm operations), writes only persisted on close/sync/flush
- **BlobFuse v1 EOL**: September 2026
- **node_modules concern**: Non-atomic renames can break package managers. Not suitable for direct node_modules mount.
- Source: [BlobFuse v2 Overview](https://learn.microsoft.com/en-us/azure/storage/blobs/blobfuse2-what-is)
- Source: [BlobFuse Mount Azure Blob as Docker Volume](https://oneuptime.com/blog/post/2026-02-08-how-to-mount-azure-blob-storage-as-a-docker-volume/view)

### Seccomp & Syscall Filtering
- **seccomp-bpf**: Kernel-level syscall filtering via BPF programs
- **Default action**: SCMP_ACT_ERRNO (deny) or SCMP_ACT_ALLOW (allowlist vs denylist approach)
- **gVisor**: Only 53 host syscalls without networking, 68 with networking (tiny surface)
- **AKS**: Default seccomp not applied in Standard mode (must apply explicitly)
- **GKE Autopilot**: Applies containerd default seccomp automatically
- Source: [Kubernetes Seccomp](https://kubernetes.io/docs/tutorials/security/seccomp/)
- Source: [Custom Seccomp Profiles](https://oneuptime.com/blog/post/2026-02-09-custom-seccomp-profiles-kubernetes/view)

### Crypto Mining Detection & Prevention
- **Attack pattern**: Malicious containers (e.g., `xmrig`) deployed, mine cryptocurrency on stolen compute
- **Detection**: Process name scanning, CPU pattern analysis, mining pool IP/domain blocking, Stratum protocol detection
- **eBPF-based runtime security**: Falco, ARMO -- kernel-level behavioral baselines
- **Key insight**: Static controls (seccomp, gVisor) can't distinguish legitimate vs malicious use of permitted syscalls
- Source: [Azure Crypto Mining Detection](https://azure.microsoft.com/en-us/blog/detect-largescale-cryptocurrency-mining-attack-against-kubernetes-clusters/)
- Source: [Cryptomining Detection in Containers (IEEE)](https://ieeexplore.ieee.org/document/9215018/)
- Source: [Securing AI Agents on GKE (ARMO)](https://www.armosec.io/blog/sandboxing-ai-agents-gke-workload-identity/)

### Preview URL & Port Forwarding
- **Coder**: Native wildcard subdomain-based port forwarding for workspace preview
- **Traefik**: Docker-aware reverse proxy with auto-discovery, wildcard subdomain routing
- **Pattern**: `*.preview.domain.com` -> Traefik -> route by subdomain to correct pod + port
- **DNS**: Wildcard CNAME + wildcard TLS cert (Let's Encrypt DNS challenge or Azure-managed)
- **Constraint**: Each DNS label <= 63 characters
- Source: [Coder Port Forwarding](https://coder.com/docs/user-guides/workspace-access/port-forwarding)
- Source: [Traefik Wildcard Subdomains](https://community.traefik.io/t/arbitrary-wildcard-subdomain-redirect-to-docker-container/7021)

### Git Credential Management in Cloud IDEs
- **Codespaces model**: GITHUB_TOKEN injected, credential helper returns token for git operations
- **Scope**: Token scoped to the repo that created the codespace (least privilege)
- **GCM (Git Credential Manager)**: Cross-platform, supports GitHub/GitLab/Azure DevOps/Bitbucket
- **git-credential-cache**: Good for ephemeral environments (no permanent storage)
- **Risk**: SSH keys don't have fine-grained repo permissions -- accidental exposure = all repos compromised
- Source: [Codespaces Auth Troubleshooting](https://docs.github.com/en/codespaces/troubleshooting/troubleshooting-authentication-to-a-repository)
- Source: [GCM GitHub](https://github.com/git-ecosystem/git-credential-manager)
- Source: [git-credential-oauth](https://github.com/hickford/git-credential-oauth)

### Container Image Optimization
- **Multi-stage builds**: Can reduce image size from 1GB to 50MB for production
- **For dev environments**: Size optimization is secondary -- developer experience is primary
- **Pre-pulling**: Critical for Kubernetes -- fresh nodes must pull all images before scheduling pods
- **Layer reuse**: Multiple language images rarely share exact base layer versions in practice
- **Distroless**: Good for production (Node.js: ~250MB), bad for development (no shell, no tools)
- **Ubuntu 22.04 LTS**: Best compatibility for development images (native npm packages, Python wheels)
- Source: [Docker Multi-Stage Builds Guide 2026](https://devtoolbox.dedyn.io/blog/docker-multi-stage-builds-guide)
- Source: [Kubernetes Image Best Practices](https://cloud.google.com/blog/products/containers-kubernetes/kubernetes-best-practices-how-and-why-to-build-small-container-images)

### CDE Landscape 2026
- **Codespaces**: `devcontainer.json`-driven, DAG-based infrastructure model, AI-powered "predictive pruning"
- **Gitpod -> Ona**: Pivoted to AI agent orchestration (Sep 2025), Gitpod Classic shut down Oct 2025
- **Replit**: $10M to $100M revenue in 9 months, but friction on "experiment to product" transition
- **CodeSandbox**: Rootless Podman + devcontainer/cli, microVM infrastructure
- **DevPod**: Open-source spiritual successor to Gitpod Classic, client-side, uses devcontainer.json
- Source: [Codespaces in 2026](https://medium.com/@ion.stefanache0/beyond-the-code-the-deterministic-magic-of-github-codespaces-in-2026-ebb2a7fdcc20)
- Source: [Codespaces Alternatives (Northflank)](https://northflank.com/blog/github-codespaces-alternatives)
- Source: [Replit Alternatives 2026](https://www.f22labs.com/blogs/12-replit-alternatives-for-development-in-2025/)
