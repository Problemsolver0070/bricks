# Bricks -- Billing & Usage System Design

> Version: 1.0  
> Date: 2026-04-08  
> Status: Design Document -- Pre-Implementation  
> Stack: Next.js + NestJS + Clerk + Stripe + PostgreSQL + Redis

---

## Table of Contents

1. [Plan Design & Pricing Architecture](#1-plan-design--pricing-architecture)
2. [Credit System Design](#2-credit-system-design)
3. [Usage Metering Architecture](#3-usage-metering-architecture)
4. [Stripe Integration -- Complete Flow](#4-stripe-integration--complete-flow)
5. [Webhook Event Handling](#5-webhook-event-handling)
6. [Free Tier Credits](#6-free-tier-credits)
7. [Team / Organization Billing](#7-team--organization-billing)
8. [Usage Dashboard](#8-usage-dashboard)
9. [Quota Enforcement](#9-quota-enforcement)
10. [Database Schema](#10-database-schema)
11. [Currency & International Tax](#11-currency--international-tax)
12. [Anti-Abuse System](#12-anti-abuse-system)
13. [Flow Diagrams](#13-flow-diagrams)
14. [Edge Cases & Failure Modes](#14-edge-cases--failure-modes)
15. [Appendix: Stripe Object Mapping](#15-appendix-stripe-object-mapping)

---

## 1. Plan Design & Pricing Architecture

### 1.1 Tier Definitions

#### Free Tier -- $0/mo

| Resource              | Limit                         | Rationale                                      |
|-----------------------|-------------------------------|------------------------------------------------|
| AI Credits            | 100 credits/month (replenish) | ~10 meaningful AI interactions                  |
| Compute Time          | 2 hrs/day                     | Daily cap; enough to evaluate, not to live on   |
| Storage               | 2 GB                          | ~10 small projects                              |
| Projects              | 3 max                         | Forces prioritization; upgrade trigger           |
| Session Duration      | Idle timeout: 10 min          | Limits resource cost per session                |
| Collaboration         | None                          | Pro feature                                      |
| AI Model              | Sonnet 4.6 only               | Quality model to showcase product               |
| Concurrent Sessions   | 1                             | Single active session                            |
| Concurrent AI Conversations | 1                       | Single active AI conversation                    |
| Container Spec        | 0.5 vCPU, 512 MB RAM          | Minimal but functional                          |
| Support               | Community only                | Forum + docs                                     |
| Budget Ceiling        | $2 per conversation           | Hard cap per conversation                        |

#### Pro Tier -- $20/mo

| Resource              | Limit                         | Rationale                                      |
|-----------------------|-------------------------------|------------------------------------------------|
| AI Credits            | 1,000 credits/month (included) | ~100 meaningful AI interactions                |
| Compute Time          | Unlimited                     | No compute cap for paid users                   |
| Storage               | 10 GB                         | ~50-100 projects                                |
| Projects              | 20 max                        | Generous cap for individual use                  |
| Session Duration      | Idle timeout: 30 min          | Long coding sessions                            |
| Collaboration         | Share via link (read-only)    | Basic sharing                                    |
| AI Model              | All models (Haiku 4.5, Sonnet 4.6, Opus 4.6) | Full model access             |
| Concurrent Sessions   | 3                             | Multiple active sessions                         |
| Concurrent AI Conversations | 3                       | Multiple active AI conversations                 |
| Container Spec        | 2 vCPU, 4 GB RAM              | Serious development                             |
| Support               | Email (48hr SLA)              | Priority over free                               |
| Overage Rate          | $0.05/credit beyond included  | Pay-as-you-go after exhaustion                  |
| Compute Overage       | $0.005/min beyond included    | $0.30/hr                                        |
| Budget Ceiling        | $5 per conversation (IDE), $10 per conversation (Builder) | Hard cap per conversation |

#### Team Tier -- $50/seat/mo (min 2 seats)

| Resource              | Limit                         | Rationale                                      |
|-----------------------|-------------------------------|------------------------------------------------|
| AI Credits            | 2,500 credits/seat/month (pooled) | Shared pool across team                     |
| Compute Time          | Unlimited                     | No compute cap for team users                   |
| Storage               | 25 GB/seat                    | Per-seat storage allocation                     |
| Projects              | Unlimited                     | No cap                                           |
| Session Duration      | Idle timeout: 2 hrs           | Extended for team workflows                     |
| Collaboration         | Real-time Y.js collab         | Core team feature                                |
| AI Model              | All models (Haiku 4.5, Sonnet 4.6, Opus 4.6) | Full model access                  |
| Concurrent Sessions   | 5 per member                  | Multiple active sessions per member              |
| Concurrent AI Conversations | 5 per member             | Multiple active AI conversations per member      |
| Per-Member Hard Cap   | 20% of team pool per day (admin-adjustable) | Prevents single-member pool drain |
| Container Spec        | 4 vCPU, 8 GB RAM              | Heavy workloads                                  |
| Support               | Priority email (24hr SLA) + chat | Faster response                               |
| Admin Controls        | Yes                           | Role management, usage policies                  |
| Audit Logs            | 90-day retention              | Compliance + debugging                           |
| SSO (SAML/OIDC)       | Available (add-on $10/mo)     | Enterprise requirement                           |
| Shared Environments   | Yes                           | Team-wide env configs + secrets                  |
| Overage Rate          | $0.05/credit beyond included  | Pay-as-you-go after exhaustion                  |
| Compute Overage       | $0.004/min beyond included    | Volume discount over Pro                        |
| Budget Ceiling        | $5 per conversation (IDE), $10 per conversation (Builder) | Hard cap per conversation |

### 1.2 Price Anchoring Strategy

The Free tier exists to create a large funnel. The Pro tier at $20/mo is the primary revenue target (individual developers). The Team tier at $50/seat/mo targets startups and teams where the per-seat model captures more revenue as organizations grow.

---

## 2. Credit System Design

### 2.1 What Is a "Credit"?

A credit is a **user-friendly abstraction** over raw API token costs. Users should never think about tokens.

**Conversion formula:**

```
1 credit = 10,000 tokens (combined input + output, weighted)
```

**Weighted token calculation:**

```
effective_tokens = input_tokens + (output_tokens * OUTPUT_WEIGHT)
```

Where `OUTPUT_WEIGHT` varies by model because output tokens cost 5x input:

| Model         | Input Cost/MTok | Output Cost/MTok | OUTPUT_WEIGHT |
|---------------|-----------------|------------------|---------------|
| Haiku 4.5     | $1.00           | $5.00            | 5.0           |
| Sonnet 4.6    | $3.00           | $15.00           | 5.0           |
| Opus 4.6      | $5.00           | $25.00           | 5.0           |

**Model multipliers (credits consumed per effective 10K tokens):**

| Model         | Credit Multiplier | Rationale                          |
|---------------|-------------------|------------------------------------|
| Haiku 4.5     | 1.0x              | Baseline                           |
| Sonnet 4.6    | 3.0x              | 3x Haiku's input cost              |
| Opus 4.6      | 10.0x             | 10x Haiku's input cost (premium model) |

**Example:**
- User sends a prompt, gets a response using Sonnet 4.6
- Input: 2,000 tokens, Output: 1,500 tokens
- Effective tokens = 2,000 + (1,500 * 5.0) = 9,500
- Base credits = 9,500 / 10,000 = 0.95
- With Sonnet multiplier: 0.95 * 3.0 = **2.85 credits**
- Rounded up to nearest 0.01: **2.85 credits deducted**

**Why this mapping?**
- Simple for users: "I have 100 credits" is understandable
- Flexible for us: We can adjust the underlying token-to-credit ratio without changing user-facing prices
- Margin built in: At $0.05/overage credit on Sonnet, our cost is ~$0.0027 per credit. That is a ~18.5x markup, which covers infrastructure, support, and profit

### 2.2 Credit Types

| Type            | Source                      | Expiry           | Priority (deducted first) |
|-----------------|-----------------------------|------------------|---------------------------|
| **Plan Credits** | Monthly plan allocation     | End of billing period | 2 (second)             |
| **Bonus Credits** | Referrals, promotions      | 90 days from grant | 1 (first -- use or lose) |
| **Purchased Credits** | One-time credit packs  | Never            | 3 (last -- most valuable) |

Deduction order: Bonus (soonest expiring first) -> Plan -> Purchased. This minimizes waste and maximizes perceived value of purchased credits.

### 2.3 Credit Deduction Timing

**Deduct on completion, not on start.** Rationale:

1. If the API call fails (timeout, error, model overload), the user should not be charged
2. If we deduct on start, we need a refund/rollback mechanism -- adds complexity and race conditions
3. We pre-validate that the user has at least an estimated minimum before starting (prevents abuse of starting calls with zero credits)

**Pre-check:** If remaining credits < minimum model cost (1 for Haiku, 3 for Sonnet, 10 for Opus), block request BEFORE calling API. This prevents free tier users from accumulating overdraft through rapid requests.

**Flow:**

```
1. User sends AI request
2. Middleware checks: user.available_credits >= minimum model cost (1 for Haiku, 3 for Sonnet, 10 for Opus)
3. If insufficient: return 402 with "Insufficient credits" message
4. Request proceeds to AI backend
5. AI response streams back to user
6. On stream completion: calculate actual credits used
7. Deduct from credit ledger (atomic transaction)
8. If deduction fails (race condition, user hit 0 mid-stream): 
   a. Allow this request to complete (grace)
   b. Set user.credit_overdraft = true
   c. Block NEXT request until credits available or purchased
```

### 2.4 Credit Ledger (Double-Entry)

Every credit movement is recorded as a ledger entry with a running balance. This is critical for auditability and dispute resolution.

```
CREDIT: +2000 (plan_allocation, period: 2026-04-01 to 2026-04-30)
DEBIT:  -2.85 (ai_usage, model: sonnet-4.6, session: sess_abc123)
DEBIT:  -1.20 (ai_usage, model: haiku-4.5, session: sess_abc123)
CREDIT: +50   (bonus, source: referral, expires: 2026-07-08)
...
Balance: 2046.95
```

---

## 3. Usage Metering Architecture

### 3.1 What We Meter

| Metric           | Unit              | Storage             | Billing Relevance        |
|------------------|-------------------|---------------------|--------------------------|
| AI Tokens        | Input + output tokens | Per-request log  | Credits / overage        |
| Compute Time     | Minutes           | Per-session log     | Overage beyond plan       |
| Storage          | Bytes             | Periodic snapshot   | Hard limit (no overage)  |
| Sessions         | Count             | Per-session log     | Analytics only            |
| Projects         | Count             | Real-time count     | Hard limit (Free tier)   |
| Bandwidth        | Bytes             | Daily aggregate     | Future billing vector     |

### 3.2 Real-Time Usage Tracking Architecture

```
                    +------------------+
                    |   API Gateway    |
                    | (Quota Check)    |
                    +--------+---------+
                             |
              +--------------+--------------+
              |                             |
    +---------v---------+        +---------v---------+
    | AI Service        |        | Compute Service   |
    | (Token Tracking)  |        | (Time Tracking)   |
    +---------+---------+        +---------+---------+
              |                             |
              |     +---------------+       |
              +---->|   Redis       |<------+
                    | (Real-time    |
                    |  Counters)    |
                    +-------+-------+
                            |
                    +-------v-------+
                    | Usage Worker  |
                    | (Async Queue) |
                    +-------+-------+
                            |
              +-------------+-------------+
              |                           |
    +---------v---------+       +---------v---------+
    | PostgreSQL        |       | Stripe Meters API |
    | (Source of Truth) |       | (Billing Sync)    |
    +-------------------+       +-------------------+
```

### 3.3 Redis Counter Strategy

**Keys:**

```
usage:{user_id}:credits:{period}      -> current credit usage (float)
usage:{user_id}:compute:{period}      -> compute minutes used (int)
usage:{user_id}:storage               -> current storage bytes (int)
usage:{org_id}:credits:{period}       -> team pooled credit usage
usage:{org_id}:compute:{period}       -> team pooled compute usage
quota:{user_id}:credits_limit         -> plan credit limit (cached)
quota:{user_id}:compute_limit         -> plan compute limit (cached)
```

Where `{period}` = `YYYY-MM` (e.g., `2026-04`).

**Operations:**
- `INCRBYFLOAT` for credit deductions (atomic)
- `INCRBY` for compute minutes
- `TTL` set to 35 days (covers full billing period + buffer)
- On billing period reset: keys naturally expire, new keys created

**Redis is NOT the source of truth.** PostgreSQL is. Redis is the fast-path for quota checks. A background worker reconciles Redis with PostgreSQL every 60 seconds. On discrepancy > 1%, an alert fires.

### 3.4 Crossing Plan Boundaries Mid-Session

**Scenario:** User is in an AI conversation. They have 5 credits left. Their next AI response costs 8 credits.

**Policy:** Allow the request to complete. The user goes into a **credit overdraft** of -3 credits. The overdraft is:

1. Recorded in the ledger as a negative balance
2. The user's next request is blocked with a message: "You've used all your included credits. Upgrade your plan or purchase a credit pack to continue."
3. If the user is on Pro/Team, the overdraft is billed as overage at the end of the billing period
4. If the user is on Free, the overdraft is forgiven (capped at 10 credits max overdraft to prevent abuse)

**For compute time:** Session continues until the current session ends naturally or hits session duration limit. No mid-session termination. Overage is billed at period end.

---

## 4. Stripe Integration -- Complete Flow

### 4.1 Stripe Object Model for Bricks

```
Stripe Customer  <--1:1-->  Bricks User (or Bricks Organization for teams)
    |
    +-- Subscription (plan: free/pro/team)
    |       |
    |       +-- Subscription Item: Base plan price (flat fee)
    |       +-- Subscription Item: Credit overage (metered, Stripe Meter)
    |       +-- Subscription Item: Compute overage (metered, Stripe Meter)
    |       +-- Subscription Item: Per-seat (for Team plan, quantity-based)
    |
    +-- Payment Methods
    +-- Invoices
    +-- Tax Settings
```

### 4.2 Stripe Meters Setup

Create two Stripe Meters:

**Meter 1: AI Credit Overage**
```json
{
  "display_name": "AI Credit Overage",
  "event_name": "bricks_credit_overage",
  "default_aggregation": { "formula": "sum" },
  "value_settings": { "event_payload_key": "credits" }
}
```

**Meter 2: Compute Overage**
```json
{
  "display_name": "Compute Overage Minutes",
  "event_name": "bricks_compute_overage",
  "default_aggregation": { "formula": "sum" },
  "value_settings": { "event_payload_key": "minutes" }
}
```

### 4.3 Stripe Products & Prices

```
Product: "Bricks Pro"
  Price: $20/month (recurring, flat fee)
  Price: $0.05/credit (metered, linked to bricks_credit_overage meter)
  Price: $0.005/minute (metered, linked to bricks_compute_overage meter)

Product: "Bricks Team"
  Price: $50/seat/month (recurring, per_unit, quantity = seat count)
  Price: $0.05/credit (metered, linked to bricks_credit_overage meter)
  Price: $0.004/minute (metered, linked to bricks_compute_overage meter)

Product: "Bricks Credit Pack"
  Price: $5 for 300 credits (one-time)
  Price: $15 for 1,000 credits (one-time)
  Price: $40 for 3,000 credits (one-time)
```

### 4.4 Customer Creation Flow

```
User signs up via Clerk
        |
        v
Clerk creates user record
        |
        v
Post-signup webhook / server action triggers:
        |
        v
Create Stripe Customer:
  stripe.customers.create({
    email: user.email,
    name: user.fullName,
    metadata: {
      bricks_user_id: user.id,
      clerk_user_id: user.clerkId,
      signup_date: new Date().toISOString(),
      plan: 'free'
    }
  })
        |
        v
Store stripe_customer_id in our users table
        |
        v
Allocate 100 Free credits in credit ledger
        |
        v
(Optional) Create a Free subscription in Stripe for tracking:
  stripe.subscriptions.create({
    customer: stripeCustomerId,
    items: [{ price: freeplanPriceId }],
    metadata: { bricks_user_id: user.id }
  })
```

**Why create a Stripe Customer for free users?**
- Smoother upgrade path (no customer creation at checkout time)
- Track free users in Stripe for analytics
- If they later add a payment method, it is already linked

### 4.5 Subscription Upgrade Flow (Free -> Pro)

```
User clicks "Upgrade to Pro"
        |
        v
Redirect to Stripe Checkout Session:
  stripe.checkout.sessions.create({
    customer: stripeCustomerId,
    mode: 'subscription',
    line_items: [
      { price: proPlanPriceId, quantity: 1 },
      { price: proCreditOveragePriceId },      // metered
      { price: proComputeOveragePriceId },      // metered
    ],
    subscription_data: {
      metadata: { bricks_user_id: user.id, plan: 'pro' }
    },
    success_url: 'https://bricks.dev/billing?success=true',
    cancel_url: 'https://bricks.dev/billing?canceled=true',
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
  })
        |
        v
User completes payment on Stripe Checkout
        |
        v
Stripe fires: checkout.session.completed
        |
        v
Webhook handler:
  1. Verify event signature
  2. Extract subscription ID and customer ID
  3. Update users table: plan = 'pro', stripe_subscription_id = sub_xxx
  4. Allocate 1,000 Pro credits for current period (prorated if mid-month)
  5. Update Redis quota cache
  6. Upgrade container spec to 2 vCPU / 4 GB RAM
  7. Send welcome-to-pro email
```

**Why Stripe Checkout over embedded form?**
- PCI compliance handled entirely by Stripe
- Supports 40+ payment methods automatically
- Built-in tax collection UI
- Mobile-optimized
- Promo code support built in
- Less code, fewer bugs

### 4.6 Subscription Lifecycle Management

#### Upgrade (Pro -> Team)

```
1. User creates an organization in Clerk
2. Initiates upgrade to Team plan
3. Create new Stripe Checkout session with Team prices
4. On checkout.session.completed:
   a. Cancel old Pro subscription (immediate, no proration refund -- 
      credit remaining Pro time to account as bonus credits)
   b. Create Team subscription with seat count = 1
   c. Migrate user to org billing context
   d. Prorate credit allocation
```

#### Downgrade (Pro -> Free)

```
1. User clicks "Downgrade to Free"
2. Show confirmation: "Your Pro features will remain until {period_end_date}"
3. On confirm:
   stripe.subscriptions.update(subId, {
     cancel_at_period_end: true
   })
4. Stripe fires: customer.subscription.updated (cancel_at_period_end = true)
5. At period end, Stripe fires: customer.subscription.deleted
6. Webhook handler:
   a. Update user plan to 'free'
   b. Reduce container spec
   c. If storage > 2GB: notify user, give 30-day grace to download
   d. If projects > 3: mark excess as read-only (not deleted)
   e. Expire remaining Pro credits at period end
   f. Allocate 100 Free credits for new period
```

#### Pause (Pro/Team)

```
stripe.subscriptions.update(subId, {
  pause_collection: {
    behavior: 'void',           // Don't invoice during pause
    resumes_at: futureTimestamp  // Optional auto-resume date
  }
})

During pause:
- User retains read-only access to projects
- No AI credits, no compute time
- Storage preserved for up to 90 days
- After 90 days paused: send warning email, then archive projects
```

#### Resume

```
stripe.subscriptions.update(subId, {
  pause_collection: ''  // Remove pause
})

On resume:
- Full plan access restored
- Fresh credit allocation for new period
- Container spec restored
```

#### Cancel (immediate)

```
stripe.subscriptions.cancel(subId, {
  prorate: true,
  invoice_now: true
})

Handler:
- Prorated refund calculated by Stripe
- Immediate plan downgrade to Free
- Same storage/project handling as downgrade
```

### 4.7 Payment Failure Handling

Stripe's Smart Retries will automatically retry failed payments. Our system layers on top:

```
invoice.payment_failed (attempt 1)
        |
        v
  1. Send email: "Payment failed -- please update your payment method"
  2. Show in-app banner: "Action required: payment issue"
  3. User retains full access (grace period starts)
        |
        v
invoice.payment_failed (attempt 2, ~3 days later)
        |
        v
  1. Send email: "Second payment attempt failed"
  2. In-app banner becomes more urgent
  3. User still retains access
        |
        v
invoice.payment_failed (attempt 3, ~5 days later)
        |
        v
  1. Send final warning email: "Your account will be downgraded in 48 hours"
  2. Full-screen modal on login
        |
        v
invoice.payment_failed (final, ~7 days from first failure)
        |
        v
  customer.subscription.updated (status: 'past_due' -> 'canceled' or 'unpaid')
        |
        v
  1. Downgrade to Free tier
  2. Same graceful degradation as voluntary downgrade
  3. Outstanding invoice remains in Stripe for collection
  4. After 30 days unpaid: write off, mark as bad debt
```

**Grace Period Matrix:**

| Event                    | Duration | User Experience           |
|--------------------------|----------|---------------------------|
| First payment failure    | Day 0    | Email + subtle banner     |
| Second retry             | Day 3    | Email + prominent banner  |
| Third retry              | Day 5    | Email + modal on login    |
| Final failure            | Day 7    | Downgrade to Free         |
| Invoice collection       | Day 37   | Write off if still unpaid |

### 4.8 Proration

**Upgrade mid-cycle (Free -> Pro on day 15 of 30-day month):**
- Stripe prorates automatically: user pays $10 for remaining 15 days
- Credit allocation: 1,000 * (15/30) = 500 credits for partial period
- Next full period: full $20 and 1,000 credits

**Downgrade mid-cycle (Pro -> Free, set to cancel at period end):**
- No refund for current period (user keeps Pro until period end)
- This is the simplest and most common approach

**Seat changes mid-cycle (Team: 3 seats -> 5 seats on day 10):**
```
stripe.subscriptions.update(subId, {
  items: [{
    id: seatItemId,
    quantity: 5,
  }],
  proration_behavior: 'create_prorations',
})
```
- Stripe creates a proration invoice item: 2 seats * ($50 * 20/30) = $66.67
- Credit pool increases immediately: +2,500 * 2 * (20/30) = +3,333 credits

### 4.9 Usage-Based Billing (Overage) -- Stripe Meter Events

**Reporting credit overage to Stripe:**

Overage only exists for Pro and Team users. Free users cannot go into overage (hard cap with small grace).

```typescript
// Called by the usage worker after credit deduction from PostgreSQL
async function reportOverageToStripe(
  userId: string,
  stripeCustomerId: string,
  overageCredits: number
): Promise<void> {
  // Only report if user has exceeded plan credits
  if (overageCredits <= 0) return;

  await stripe.v2.billing.meterEvents.create({
    event_name: 'bricks_credit_overage',
    payload: {
      stripe_customer_id: stripeCustomerId,
      value: Math.ceil(overageCredits).toString(), // Whole numbers only
    },
    // Idempotency: prevent double-billing on retries
    identifier: `overage_${userId}_${usageRecordId}`,
  });
}
```

**Reporting compute overage to Stripe:**

```typescript
async function reportComputeOverageToStripe(
  userId: string, 
  stripeCustomerId: string,
  overageMinutes: number
): Promise<void> {
  if (overageMinutes <= 0) return;

  await stripe.v2.billing.meterEvents.create({
    event_name: 'bricks_compute_overage',
    payload: {
      stripe_customer_id: stripeCustomerId,
      value: Math.ceil(overageMinutes).toString(),
    },
    identifier: `compute_overage_${userId}_${usageRecordId}`,
  });
}
```

**Batching strategy:** Do NOT send per-request events to Stripe. Accumulate in PostgreSQL, then a cron job (every 15 minutes) flushes aggregated overage to Stripe Meters. This:
- Stays well under the 1,000 events/sec rate limit
- Reduces Stripe API costs
- Handles Stripe downtime gracefully (retry queue)

**Flush exactly-once guarantee:** Use `stripe_reporting_started_at` + `stripe_reported_at` state machine on usage records. Read `WHERE reported_at IS NULL AND reporting_started_at IS NULL`. Set `reporting_started_at` before sending to Stripe. Set `reported_at` on success. Reset `reporting_started_at` to NULL on failure. Stale detection: if `reporting_started_at` > 10 min ago and `reported_at IS NULL`, reset for retry. This prevents double-reporting on worker crashes and ensures every usage record is reported exactly once.

### 4.10 Invoicing

Stripe generates invoices automatically for subscriptions. Key configuration:

```typescript
// Subscription creation includes:
{
  collection_method: 'charge_automatically',
  days_until_due: null, // Auto-charge, not send-invoice
  payment_settings: {
    save_default_payment_method: 'on_subscription',
  },
}
```

**Invoice lifecycle:**
1. `invoice.upcoming` fires ~3 days before period end
2. Usage worker flushes any remaining overage to Stripe Meters
3. `invoice.created` fires -- Stripe pulls meter event summaries, creates line items
4. ~1 hour window to add custom line items if needed
5. `invoice.finalized` fires -- invoice is locked
6. `invoice.payment_succeeded` or `invoice.payment_failed` fires

### 4.11 Refund Policy & Implementation

**Policy:**
- Full refund if canceled within 48 hours of initial subscription (no questions asked)
- Prorated refund if canceled after 48 hours but within first 14 days
- No refund after 14 days (proration credit applies to next period)
- Overage charges are non-refundable (usage already consumed)
- Credit pack purchases are non-refundable (but credits never expire)

**Implementation:**
```typescript
async function processRefund(
  subscriptionId: string,
  reason: 'requested_by_customer' | 'duplicate' | 'fraudulent'
): Promise<void> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const daysSinceStart = daysBetween(sub.start_date, now());

  if (daysSinceStart <= 2) {
    // Full refund
    const latestInvoice = await stripe.invoices.retrieve(sub.latest_invoice);
    await stripe.refunds.create({
      payment_intent: latestInvoice.payment_intent,
      reason: reason,
    });
  } else if (daysSinceStart <= 14) {
    // Prorated refund
    const unusedDays = sub.current_period_end - now();
    const totalDays = sub.current_period_end - sub.current_period_start;
    const refundAmount = Math.floor(
      (latestInvoice.amount_paid * unusedDays) / totalDays
    );
    await stripe.refunds.create({
      payment_intent: latestInvoice.payment_intent,
      amount: refundAmount,
      reason: reason,
    });
  }
  // else: no refund, handled by cancel_at_period_end
}
```

---

## 5. Webhook Event Handling

### 5.1 Events We Listen For

| Event | Action | Priority |
|-------|--------|----------|
| `checkout.session.completed` | Create/upgrade subscription in our DB, allocate credits, upgrade resources | CRITICAL |
| `customer.subscription.created` | Record subscription, set plan tier | CRITICAL |
| `customer.subscription.updated` | Handle plan changes, pause/resume, status changes | CRITICAL |
| `customer.subscription.deleted` | Downgrade to free, handle graceful degradation | CRITICAL |
| `customer.subscription.paused` | Restrict access to read-only | HIGH |
| `customer.subscription.resumed` | Restore full access | HIGH |
| `invoice.payment_succeeded` | Confirm payment, reset any payment failure banners | CRITICAL |
| `invoice.payment_failed` | Start grace period flow, notify user | CRITICAL |
| `invoice.upcoming` | Flush pending overage to Stripe, send usage summary email | HIGH |
| `invoice.created` | Validate line items, add any custom charges | HIGH |
| `invoice.finalized` | Record final invoice in our DB | MEDIUM |
| `customer.updated` | Sync email/name changes | LOW |
| `payment_method.attached` | Update default payment method reference | LOW |
| `payment_method.detached` | Check if user still has valid payment method | MEDIUM |
| `charge.dispute.created` | Flag account, begin dispute response flow | CRITICAL |
| `charge.dispute.closed` | Update dispute status, potentially ban user | HIGH |
| `customer.tax_id.created` | Record VAT ID for compliance | LOW |
| `customer.tax_id.updated` | Update VAT ID status | LOW |

### 5.2 Webhook Handler Architecture

```typescript
// POST /api/webhooks/stripe
async function handleStripeWebhook(req: Request): Promise<Response> {
  // 1. Verify signature (CRITICAL -- never skip)
  const sig = req.headers['stripe-signature'];
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return new Response('Invalid signature', { status: 400 });
  }

  // 2. Idempotency check -- have we processed this event before?
  const existing = await db.stripeEvents.findUnique({
    where: { stripe_event_id: event.id }
  });
  if (existing?.status === 'processed') {
    return new Response('Already processed', { status: 200 });
  }

  // 3. Record event as "processing"
  await db.stripeEvents.upsert({
    where: { stripe_event_id: event.id },
    create: {
      stripe_event_id: event.id,
      type: event.type,
      status: 'processing',
      payload: event,
      received_at: new Date(),
    },
    update: { status: 'processing' },
  });

  // 4. Route to handler
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
      case 'invoice.upcoming':
        await handleInvoiceUpcoming(event.data.object);
        break;
      case 'charge.dispute.created':
        await handleDisputeCreated(event.data.object);
        break;
      // ... other handlers
      default:
        // Log unhandled event type for monitoring
        logger.info(`Unhandled Stripe event: ${event.type}`);
    }

    // 5. Mark as processed
    await db.stripeEvents.update({
      where: { stripe_event_id: event.id },
      data: { status: 'processed', processed_at: new Date() },
    });
  } catch (err) {
    // 6. Mark as failed, will be retried
    await db.stripeEvents.update({
      where: { stripe_event_id: event.id },
      data: { status: 'failed', error: err.message },
    });
    // Return 500 so Stripe retries
    return new Response('Processing error', { status: 500 });
  }

  return new Response('OK', { status: 200 });
}
```

### 5.3 Critical Handler: checkout.session.completed

```typescript
async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session
): Promise<void> {
  const userId = session.subscription_data?.metadata?.bricks_user_id
    || session.metadata?.bricks_user_id;
  
  if (!userId) {
    throw new Error('Missing bricks_user_id in checkout session metadata');
  }

  const subscription = await stripe.subscriptions.retrieve(
    session.subscription as string
  );

  const planType = determinePlanFromSubscription(subscription);
  const periodStart = new Date(subscription.current_period_start * 1000);
  const periodEnd = new Date(subscription.current_period_end * 1000);

  await db.$transaction(async (tx) => {
    // Update user record
    await tx.users.update({
      where: { id: userId },
      data: {
        plan: planType,
        stripe_customer_id: session.customer as string,
        stripe_subscription_id: subscription.id,
        subscription_status: subscription.status,
        current_period_start: periodStart,
        current_period_end: periodEnd,
      },
    });

    // Calculate prorated credits
    const totalDaysInPeriod = daysBetween(periodStart, periodEnd);
    const remainingDays = daysBetween(new Date(), periodEnd);
    const creditAllocation = Math.ceil(
      getPlanCredits(planType) * (remainingDays / totalDaysInPeriod)
    );

    // Allocate credits
    await tx.creditLedger.create({
      data: {
        user_id: userId,
        type: 'plan_allocation',
        amount: creditAllocation,
        balance_after: creditAllocation, // Will be computed properly
        period_start: periodStart,
        period_end: periodEnd,
        description: `${planType} plan credit allocation (prorated)`,
      },
    });

    // Record subscription in our subscriptions table
    await tx.subscriptions.upsert({
      where: { user_id: userId },
      create: {
        user_id: userId,
        stripe_subscription_id: subscription.id,
        stripe_customer_id: session.customer as string,
        plan: planType,
        status: subscription.status,
        current_period_start: periodStart,
        current_period_end: periodEnd,
      },
      update: {
        stripe_subscription_id: subscription.id,
        plan: planType,
        status: subscription.status,
        current_period_start: periodStart,
        current_period_end: periodEnd,
      },
    });
  });

  // Update Redis cache (outside transaction, eventual consistency is OK)
  await updateRedisQuota(userId, planType);

  // Trigger container upgrade
  await containerOrchestrator.upgradeUserContainer(userId, planType);

  // Send welcome email
  await emailService.sendPlanWelcome(userId, planType);
}
```

### 5.4 Critical Handler: invoice.payment_succeeded (Period Renewal)

```typescript
async function handlePaymentSucceeded(
  invoice: Stripe.Invoice
): Promise<void> {
  if (invoice.billing_reason !== 'subscription_cycle') return;
  // Only handle renewals, not first payment (handled by checkout.session.completed)

  const customerId = invoice.customer as string;
  const user = await db.users.findFirst({
    where: { stripe_customer_id: customerId },
  });
  if (!user) {
    throw new Error(`No user found for Stripe customer ${customerId}`);
  }

  const subscription = await stripe.subscriptions.retrieve(
    invoice.subscription as string
  );

  const periodStart = new Date(subscription.current_period_start * 1000);
  const periodEnd = new Date(subscription.current_period_end * 1000);

  await db.$transaction(async (tx) => {
    // Expire any remaining credits from previous period
    await tx.creditLedger.create({
      data: {
        user_id: user.id,
        type: 'period_expiry',
        amount: -(await getRemainingPlanCredits(user.id)),
        period_start: user.current_period_start,
        period_end: user.current_period_end,
        description: 'Previous period plan credits expired',
      },
    });

    // Allocate fresh credits for new period
    const newCredits = getPlanCredits(user.plan);
    await tx.creditLedger.create({
      data: {
        user_id: user.id,
        type: 'plan_allocation',
        amount: newCredits,
        period_start: periodStart,
        period_end: periodEnd,
        description: `${user.plan} plan credit allocation`,
      },
    });

    // Update period dates
    await tx.users.update({
      where: { id: user.id },
      data: {
        current_period_start: periodStart,
        current_period_end: periodEnd,
        subscription_status: 'active',
        payment_failed: false,
      },
    });

    // Record invoice
    await tx.invoices.create({
      data: {
        user_id: user.id,
        stripe_invoice_id: invoice.id,
        amount_paid: invoice.amount_paid,
        currency: invoice.currency,
        period_start: periodStart,
        period_end: periodEnd,
        status: 'paid',
        hosted_invoice_url: invoice.hosted_invoice_url,
        invoice_pdf: invoice.invoice_pdf,
      },
    });
  });

  // Reset Redis counters for new period
  await resetRedisUsageCounters(user.id, periodStart);

  // Clear any payment failure banners
  await notificationService.clearPaymentFailureBanners(user.id);
}
```

---

## 6. Free Tier Credits

### 6.1 Initial Allocation

| What                | Amount      | Notes                                      |
|---------------------|-------------|---------------------------------------------|
| Signup bonus        | 100 credits | Immediate on account creation               |
| Monthly replenish   | 100 credits | On the 1st of each month (UTC)              |
| Referral bonus      | 100 credits | Per referred user who signs up + verifies email |
| Referred user bonus | 50 credits  | The new user also gets 50 bonus credits     |

### 6.2 Credit Expiry

| Credit Type    | Expires                                  |
|----------------|------------------------------------------|
| Plan credits   | End of billing period (unused do not roll over) |
| Bonus credits  | 90 days from grant date                  |
| Purchased      | Never                                    |

### 6.3 Earning Additional Credits

| Action                          | Credits | Limit                    |
|---------------------------------|---------|--------------------------|
| Refer a friend (who signs up)   | 100     | 10 referrals max (1,000) |
| Complete onboarding tutorial    | 25      | One-time                 |
| Connect GitHub account          | 25      | One-time                 |
| Star Bricks on GitHub (if OSS)  | 10      | One-time                 |
| Seasonal promotions             | Varies  | Time-limited             |

### 6.4 Credit Deduction on Failure

| Scenario                         | Credits Deducted? | Rationale                         |
|----------------------------------|-------------------|-----------------------------------|
| API call succeeds                | Yes (actual)      | Normal usage                      |
| API call fails (our error/5xx)   | No                | Not the user's fault              |
| API call fails (model overload)  | No                | Transient, not user's fault       |
| API call times out               | No                | Partial response discarded        |
| API call fails (bad input/4xx)   | No                | User error, but still no charge   |
| Streaming response, user cancels mid-stream | Yes (partial) | Tokens already consumed by AI |
| Streaming response, connection drops | Yes (partial) | Tokens already consumed by AI    |

### 6.5 Showing Credits in UI

```
+------------------------------------------+
|  AI Credits                              |
|  ========                                |
|  [==========================------] 87% |
|  87 / 100 credits remaining              |
|                                          |
|  Resets in: 22 days                      |
|  + 50 bonus credits (expires in 45 days) |
|                                          |
|  [Upgrade to Pro: 1,000 credits/mo]      |
+------------------------------------------+
```

**Update frequency:** Real-time via WebSocket. After each AI interaction, the server pushes the new balance to the client. The UI animates the change (counter decrements smoothly).

---

## 7. Team / Organization Billing

### 7.1 Billing Entity

The **organization** is the billing entity for Team plans, not individual users. One organization = one Stripe Customer = one subscription.

```
Organization
  |-- Owner (billing admin by default)
  |-- Billing Admin(s) (can manage payment, seats)
  |-- Members (use resources, view own usage)
  |-- Viewers (read-only project access, no AI/compute usage)
```

### 7.2 Seat Management

**Adding a seat:**
```typescript
async function addTeamMember(orgId: string, userId: string): Promise<void> {
  const org = await db.organizations.findUnique({ where: { id: orgId } });
  const currentSeats = await db.orgMembers.count({ where: { org_id: orgId } });
  const newSeatCount = currentSeats + 1;

  // Update Stripe subscription quantity
  await stripe.subscriptions.update(org.stripe_subscription_id, {
    items: [{
      id: org.stripe_seat_item_id,
      quantity: newSeatCount,
    }],
    proration_behavior: 'create_prorations',
  });

  // Add member to org
  await db.orgMembers.create({
    data: {
      org_id: orgId,
      user_id: userId,
      role: 'member',
      added_at: new Date(),
    },
  });

  // Increase credit pool
  const remainingDays = daysBetween(new Date(), org.current_period_end);
  const totalDays = daysBetween(org.current_period_start, org.current_period_end);
  const additionalCredits = Math.ceil(2500 * (remainingDays / totalDays));
  
  await allocateOrgCredits(orgId, additionalCredits, 'seat_addition');
}
```

**Removing a seat mid-cycle:**
```typescript
async function removeTeamMember(orgId: string, userId: string): Promise<void> {
  const org = await db.organizations.findUnique({ where: { id: orgId } });
  const currentSeats = await db.orgMembers.count({ where: { org_id: orgId } });
  
  if (currentSeats <= 2) {
    throw new Error('Team plan requires minimum 2 seats');
  }

  const newSeatCount = currentSeats - 1;

  // Update Stripe (proration: credit applied to next invoice)
  await stripe.subscriptions.update(org.stripe_subscription_id, {
    items: [{
      id: org.stripe_seat_item_id,
      quantity: newSeatCount,
    }],
    proration_behavior: 'create_prorations',
  });

  // Remove member
  await db.orgMembers.delete({
    where: { org_id_user_id: { org_id: orgId, user_id: userId } },
  });

  // Do NOT reduce credit pool mid-cycle (goodwill)
  // Pool will be recalculated at next renewal
}
```

### 7.3 Shared Usage Pool vs Per-Member Limits

**Decision: Shared pool with per-member soft limits.**

- The organization has a total credit pool = 2,500 * seat_count
- Each member has a **soft limit** of 2,500 credits (configurable by admin)
- When a member exceeds their soft limit, the admin is notified but the member is NOT blocked (they draw from the shared pool)
- When the shared pool is exhausted, ALL members are blocked (or overage kicks in)
- Admin can set hard per-member caps if needed

**Rationale:** Shared pools are more flexible for teams where some members are heavy AI users and others are light. Hard per-member limits cause friction when one developer needs more than their share for a sprint.

### 7.4 Admin Controls

| Feature                     | Description                                           |
|-----------------------------|-------------------------------------------------------|
| Per-member usage caps       | Optional hard cap per member (default: none)          |
| Overage spending limit      | Max overage spend per billing period (default: $100)  |
| Model restrictions          | Restrict which AI models members can use              |
| Seat management             | Add/remove members, change roles                      |
| Usage alerts                | Email when pool hits 50%, 80%, 95%                    |
| Audit log                   | Who did what, when (90-day retention)                 |
| SSO enforcement             | Require SSO for all members (add-on)                  |
| IP allowlisting             | Restrict access to specific IP ranges                 |

---

## 8. Usage Dashboard

### 8.1 Individual User Dashboard

```
+================================================================+
|  BILLING OVERVIEW                                    Pro Plan   |
|================================================================|
|                                                                 |
|  AI Credits          Compute Time         Storage               |
|  ============        ============         =========             |
|  623 / 1,000         Unlimited             2.1 / 10 GB          |
|  [==========----]    [========------]      [===----------]      |
|  62% used            57% used              21% used             |
|                                                                 |
|  Overage this period: $0.00                                     |
|  Next billing date: May 1, 2026                                 |
|  Payment method: Visa ****4242                                  |
|                                                                 |
|----------------------------------------------------------------|
|  USAGE HISTORY (last 30 days)                                   |
|                                                                 |
|  [Line chart: daily credit usage]                               |
|  [Bar chart: credits by model (Haiku vs Sonnet)]                |
|                                                                 |
|----------------------------------------------------------------|
|  RECENT AI INTERACTIONS                                         |
|                                                                 |
|  Apr 8  | 3.2 credits | Sonnet 4.6  | "Refactor auth module"   |
|  Apr 8  | 0.8 credits | Haiku 4.5   | "Explain this error"     |
|  Apr 7  | 5.1 credits | Sonnet 4.6  | "Write unit tests for.." |
|  ...                                                            |
|                                                                 |
|  [View All] [Export CSV]                                        |
|----------------------------------------------------------------|
|  INVOICES                                                       |
|                                                                 |
|  Apr 1, 2026 | $20.00 + $3.45 overage | Paid | [PDF] [View]     |
|  Mar 1, 2026 | $20.00                | Paid | [PDF] [View]       |
|  Feb 1, 2026 | $20.00 + $1.20 overage | Paid | [PDF] [View]     |
|                                                                 |
+================================================================+
```

### 8.2 Team Admin Dashboard

```
+================================================================+
|  TEAM BILLING OVERVIEW                    Team Plan (5 seats)   |
|================================================================|
|                                                                 |
|  Team Credit Pool     Team Compute        Team Storage          |
|  ================     ============        ============          |
|  9,120 / 12,500       42,100 / 60,000    12.4 / 125 GB         |
|  [=============---]   [===========----]   [====----------]      |
|  73% used             70% used            25% used              |
|                                                                 |
|  Overage this period: $12.30                                    |
|  Monthly cost: $250.00 (5 seats x $50)                          |
|  Spending limit: $100.00 overage cap                            |
|                                                                 |
|----------------------------------------------------------------|
|  PER-MEMBER USAGE                                               |
|                                                                 |
|  Member         | Credits Used | Compute  | Role    | Status   |
|  ---------------|-------------|----------|---------|----------|
|  Alice (owner)  | 5,200       | 12,400m  | Admin   | Active   |
|  Bob            | 4,800       | 10,200m  | Member  | Active   |
|  Carol          | 3,100       | 8,500m   | Member  | Active   |
|  Dave           | 3,940       | 7,200m   | Member  | Active   |
|  Eve            | 1,200       | 3,800m   | Viewer  | Active   |
|                                                                 |
|  [Manage Members] [Set Usage Caps] [Export Report]              |
|                                                                 |
|----------------------------------------------------------------|
|  USAGE TRENDS                                                   |
|                                                                 |
|  [Stacked area chart: per-member credit usage over time]        |
|  [Pie chart: usage by AI model]                                 |
|  [Line chart: daily team compute minutes]                       |
|                                                                 |
|----------------------------------------------------------------|
|  AUDIT LOG (last 90 days)                                       |
|                                                                 |
|  Apr 8 14:32 | Alice  | Added member: Frank                    |
|  Apr 7 09:15 | Bob    | Changed model to Opus 4.6              |
|  Apr 6 16:45 | Alice  | Updated spending limit to $100          |
|  ...                                                            |
|  [View All] [Export CSV]                                        |
+================================================================+
```

### 8.3 Update Strategy

| Data Point         | Update Method    | Frequency           |
|--------------------|------------------|---------------------|
| Credit balance     | WebSocket push   | Real-time (per AI call) |
| Compute time used  | WebSocket push   | Every 60 seconds    |
| Storage used       | API poll         | Every 5 minutes     |
| Usage history      | API poll         | On page load + refresh |
| Invoice list       | API poll         | On page load        |
| Team member usage  | API poll         | Every 2 minutes     |
| Audit log          | API poll         | On page load        |

### 8.4 Export Capabilities

- **CSV Export:** Usage records, credit transactions, team member usage
- **PDF Invoices:** Generated by Stripe, accessible via `invoice.invoice_pdf` URL
- **JSON API:** For programmatic access (useful for finance teams)
- **Date range filtering:** Custom date range for all exports

---

## 9. Quota Enforcement

### 9.1 Enforcement Points

```
User Request
     |
     v
[1] API Gateway Middleware (NestJS Guard)
     |  - Check Redis for credit balance
     |  - Check Redis for compute time
     |  - Check PostgreSQL for storage / project count (cached)
     |  - Decision: ALLOW / BLOCK / WARN
     |
     v (if ALLOW)
[2] AI Service Pre-Check
     |  - Estimate token cost for this request
     |  - Verify user has enough credits for minimum response
     |
     v (if ALLOW)
[3] AI Service Post-Completion
     |  - Calculate actual credit cost
     |  - Deduct from Redis (atomic)
     |  - Queue PostgreSQL write
     |  - If overage: queue Stripe meter event
     |
     v
[4] Session Manager (Compute Time)
     |  - Track session duration continuously
     |  - Warn at 80% of session limit
     |  - Hard stop at session duration limit
     |  - Warn at 90% of monthly compute limit
```

### 9.2 Quota Check Response Matrix

| Situation | HTTP Code | User Experience |
|-----------|-----------|-----------------|
| Sufficient credits, within limits | 200 | Normal operation |
| Credits at 80% of plan | 200 + header | In-app toast: "You've used 80% of your credits" |
| Credits at 95% of plan | 200 + header | In-app banner: "5% credits remaining. Consider upgrading." |
| Credits exhausted, paid plan | 200 (overage) | Banner: "Using overage credits ($0.05/credit)" |
| Credits exhausted, free plan | 402 | AI chat message: "You've used all your free credits this month. Upgrade to Pro for 1,000 credits/mo, or wait until {reset_date}." |
| Compute time exhausted, paid plan | 200 (overage) | Banner: "Using overage compute ($0.005/min)" |
| Compute time exhausted, free plan | 403 | Modal: "Free compute limit reached. Your session will end." |
| Storage limit reached | 507 | Block file creation: "Storage limit reached. Delete files or upgrade." |
| Project limit reached (free) | 403 | Block project creation: "Free plan limited to 3 projects. Upgrade to Pro for unlimited." |
| Session duration limit | - | Warning at T-5min, then session terminated gracefully |
| Account suspended (payment failure) | 403 | Full-screen: "Payment issue. Please update your payment method." |

### 9.3 Handling Mid-Conversation Credit Exhaustion

This is the most delicate UX moment in the product.

**Scenario:** User is in a multi-turn AI conversation. They have 3 credits left. Their latest message will cost ~5 credits.

**Flow:**
```
1. Pre-check: user has 3 credits. Minimum threshold is 1 credit. ALLOW.
2. AI generates response (streaming).
3. Response completes. Actual cost: 5.2 credits.
4. Deduct 5.2 credits. New balance: -2.2 credits.
5. For FREE users:
   a. Allow this response (already generated).
   b. Insert system message in chat: 
      "You've used your free credits for this month. 
       Your credits will replenish on {date}. 
       Upgrade to Pro for 1,000 credits/month."
   c. Disable the input field. Show upgrade CTA.
   d. The -2.2 overdraft is forgiven (max 10 credits).
6. For PAID users:
   a. Allow this response.
   b. Show subtle banner: "Now using overage credits"
   c. Continue conversation normally.
```

**Why allow the response to complete?**
- Cutting off mid-response is terrible UX
- The tokens are already consumed (and paid for by us)
- The cost of a few extra credits is far less than the cost of user frustration
- The overdraft cap (10 credits for free users) limits abuse

### 9.4 Grace Period Design

| Plan  | Grace Behavior | Overdraft Cap | Recovery |
|-------|----------------|---------------|----------|
| Free  | Allow current request to complete | 10 credits | Wait for reset or upgrade |
| Pro   | Automatic overage billing | None (spending limit optional) | Billed on next invoice |
| Team  | Automatic overage billing | Configurable by admin | Billed on next invoice |

---

## 10. Database Schema

### 10.1 Core Tables

```sql
-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clerk_user_id           VARCHAR(255) UNIQUE NOT NULL,
    email                   VARCHAR(255) NOT NULL,
    full_name               VARCHAR(255),
    
    -- Billing
    stripe_customer_id      VARCHAR(255) UNIQUE,
    plan                    VARCHAR(20) NOT NULL DEFAULT 'free' 
                            CHECK (plan IN ('free', 'pro', 'team')),
    subscription_status     VARCHAR(20) DEFAULT 'active'
                            CHECK (subscription_status IN (
                              'active', 'past_due', 'canceled', 
                              'paused', 'unpaid', 'trialing'
                            )),
    current_period_start    TIMESTAMPTZ,
    current_period_end      TIMESTAMPTZ,
    payment_failed          BOOLEAN DEFAULT FALSE,
    payment_failed_at       TIMESTAMPTZ,
    
    -- Organization (null for individual users)
    organization_id         UUID REFERENCES organizations(id),
    org_role                VARCHAR(20) CHECK (org_role IN (
                              'owner', 'billing_admin', 'member', 'viewer'
                            )),
    
    -- Anti-abuse
    signup_ip               INET,
    device_fingerprint      VARCHAR(512),
    risk_score              SMALLINT DEFAULT 0,
    is_suspended            BOOLEAN DEFAULT FALSE,
    
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_stripe_customer ON users(stripe_customer_id);
CREATE INDEX idx_users_plan ON users(plan);
CREATE INDEX idx_users_org ON users(organization_id);

-- ============================================================
-- ORGANIZATIONS (Team billing entity)
-- ============================================================
CREATE TABLE organizations (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    VARCHAR(255) NOT NULL,
    slug                    VARCHAR(255) UNIQUE NOT NULL,
    clerk_org_id            VARCHAR(255) UNIQUE,
    
    -- Billing
    stripe_customer_id      VARCHAR(255) UNIQUE,
    stripe_subscription_id  VARCHAR(255),
    stripe_seat_item_id     VARCHAR(255),
    seat_count              INTEGER NOT NULL DEFAULT 2,
    plan                    VARCHAR(20) NOT NULL DEFAULT 'team',
    subscription_status     VARCHAR(20) DEFAULT 'active',
    current_period_start    TIMESTAMPTZ,
    current_period_end      TIMESTAMPTZ,
    
    -- Limits
    overage_spending_limit  INTEGER DEFAULT 10000, -- cents ($100 default)
    per_member_credit_cap   INTEGER, -- null = no cap
    allowed_models          JSONB DEFAULT '["haiku-4.5", "sonnet-4.6", "opus-4.6"]',
    
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SUBSCRIPTIONS (Our record of Stripe subscriptions)
-- ============================================================
CREATE TABLE subscriptions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID REFERENCES users(id),
    organization_id         UUID REFERENCES organizations(id),
    
    stripe_subscription_id  VARCHAR(255) UNIQUE NOT NULL,
    stripe_customer_id      VARCHAR(255) NOT NULL,
    plan                    VARCHAR(20) NOT NULL,
    status                  VARCHAR(20) NOT NULL,
    
    current_period_start    TIMESTAMPTZ NOT NULL,
    current_period_end      TIMESTAMPTZ NOT NULL,
    cancel_at_period_end    BOOLEAN DEFAULT FALSE,
    canceled_at             TIMESTAMPTZ,
    paused_at               TIMESTAMPTZ,
    
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Either user_id or organization_id must be set
    CONSTRAINT chk_billing_entity CHECK (
        (user_id IS NOT NULL AND organization_id IS NULL) OR
        (user_id IS NULL AND organization_id IS NOT NULL)
    )
);

CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_org ON subscriptions(organization_id);
CREATE INDEX idx_subscriptions_stripe ON subscriptions(stripe_subscription_id);

-- ============================================================
-- CREDIT LEDGER (Double-entry, append-only)
-- ============================================================
CREATE TABLE credit_ledger (
    id                      BIGSERIAL PRIMARY KEY,
    user_id                 UUID REFERENCES users(id),
    organization_id         UUID REFERENCES organizations(id),
    
    -- Transaction details
    type                    VARCHAR(30) NOT NULL CHECK (type IN (
                              'plan_allocation', 'bonus', 'purchase',
                              'ai_usage', 'compute_usage',
                              'period_expiry', 'bonus_expiry',
                              'refund', 'adjustment', 'referral'
                            )),
    amount                  DECIMAL(12,4) NOT NULL, -- positive = credit, negative = debit
    balance_after           DECIMAL(12,4) NOT NULL,
    
    -- Context
    description             TEXT,
    model                   VARCHAR(50),           -- for ai_usage entries
    session_id              VARCHAR(255),
    input_tokens            INTEGER,
    output_tokens           INTEGER,
    
    -- Expiry tracking
    expires_at              TIMESTAMPTZ,
    period_start            TIMESTAMPTZ,
    period_end              TIMESTAMPTZ,
    
    -- Metadata
    idempotency_key         VARCHAR(255) UNIQUE,   -- prevent double-processing
    stripe_meter_event_id   VARCHAR(255),
    
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Critical index: efficiently query current balance and period usage
CREATE INDEX idx_credit_ledger_user_created 
    ON credit_ledger(user_id, created_at DESC);
CREATE INDEX idx_credit_ledger_org_created 
    ON credit_ledger(organization_id, created_at DESC);
CREATE INDEX idx_credit_ledger_user_period 
    ON credit_ledger(user_id, period_start, period_end);
CREATE INDEX idx_credit_ledger_type 
    ON credit_ledger(type);
CREATE INDEX idx_credit_ledger_idempotency 
    ON credit_ledger(idempotency_key);

-- ============================================================
-- USAGE RECORDS (Detailed per-interaction log)
-- ============================================================
CREATE TABLE usage_records (
    id                      BIGSERIAL PRIMARY KEY,
    user_id                 UUID NOT NULL REFERENCES users(id),
    organization_id         UUID REFERENCES organizations(id),
    
    -- What was used
    usage_type              VARCHAR(20) NOT NULL CHECK (usage_type IN (
                              'ai_interaction', 'compute_session', 'storage_snapshot'
                            )),
    
    -- AI-specific fields
    model                   VARCHAR(50),
    input_tokens            INTEGER,
    output_tokens           INTEGER,
    credits_consumed        DECIMAL(10,4),
    prompt_summary          VARCHAR(200), -- truncated first 200 chars
    
    -- Compute-specific fields
    session_id              VARCHAR(255),
    duration_seconds        INTEGER,
    container_spec          VARCHAR(50),
    
    -- Storage-specific fields
    storage_bytes           BIGINT,
    
    -- Period
    billing_period          VARCHAR(7), -- YYYY-MM format
    
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Monthly partitions (create via cron or migration)
CREATE TABLE usage_records_2026_04 PARTITION OF usage_records
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE usage_records_2026_05 PARTITION OF usage_records
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
-- ... (auto-create future partitions via scheduled job)

CREATE INDEX idx_usage_records_user_period 
    ON usage_records(user_id, billing_period);
CREATE INDEX idx_usage_records_org_period 
    ON usage_records(organization_id, billing_period);
CREATE INDEX idx_usage_records_type_created 
    ON usage_records(usage_type, created_at);

-- ============================================================
-- CREDIT BALANCES (Materialized view for fast lookups)
-- ============================================================
CREATE MATERIALIZED VIEW credit_balances AS
SELECT
    user_id,
    organization_id,
    SUM(amount) AS total_balance,
    SUM(CASE WHEN type = 'plan_allocation' AND period_end > NOW() 
        THEN amount ELSE 0 END) AS plan_credits_remaining,
    SUM(CASE WHEN type = 'bonus' AND (expires_at IS NULL OR expires_at > NOW()) 
        THEN amount ELSE 0 END) AS bonus_credits_remaining,
    SUM(CASE WHEN type = 'purchase' 
        THEN amount ELSE 0 END) AS purchased_credits_remaining,
    SUM(CASE WHEN amount < 0 AND created_at >= date_trunc('month', NOW()) 
        THEN ABS(amount) ELSE 0 END) AS credits_used_this_month,
    MAX(created_at) AS last_updated
FROM credit_ledger
GROUP BY user_id, organization_id;

-- Refresh every 5 minutes via pg_cron
-- SELECT cron.schedule('refresh_credit_balances', '*/5 * * * *', 
--   'REFRESH MATERIALIZED VIEW CONCURRENTLY credit_balances');

-- ============================================================
-- INVOICES (Our record of Stripe invoices)
-- ============================================================
CREATE TABLE invoices (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID REFERENCES users(id),
    organization_id         UUID REFERENCES organizations(id),
    
    stripe_invoice_id       VARCHAR(255) UNIQUE NOT NULL,
    amount_paid             INTEGER NOT NULL, -- cents
    amount_due              INTEGER NOT NULL, -- cents
    currency                VARCHAR(3) NOT NULL DEFAULT 'usd',
    status                  VARCHAR(20) NOT NULL CHECK (status IN (
                              'draft', 'open', 'paid', 'void', 'uncollectible'
                            )),
    
    period_start            TIMESTAMPTZ,
    period_end              TIMESTAMPTZ,
    hosted_invoice_url      TEXT,
    invoice_pdf             TEXT,
    
    -- Breakdown
    base_amount             INTEGER, -- cents (plan fee)
    credit_overage_amount   INTEGER, -- cents
    compute_overage_amount  INTEGER, -- cents
    tax_amount              INTEGER, -- cents
    
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invoices_user ON invoices(user_id, created_at DESC);
CREATE INDEX idx_invoices_org ON invoices(organization_id, created_at DESC);

-- ============================================================
-- STRIPE EVENTS (Webhook idempotency & audit trail)
-- ============================================================
CREATE TABLE stripe_events (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stripe_event_id         VARCHAR(255) UNIQUE NOT NULL,
    type                    VARCHAR(100) NOT NULL,
    status                  VARCHAR(20) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
    payload                 JSONB NOT NULL,
    error                   TEXT,
    
    received_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at            TIMESTAMPTZ,
    
    -- Cleanup: events older than 90 days can be archived
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stripe_events_event_id ON stripe_events(stripe_event_id);
CREATE INDEX idx_stripe_events_status ON stripe_events(status) WHERE status != 'processed';
CREATE INDEX idx_stripe_events_type ON stripe_events(type);

-- ============================================================
-- CREDIT PURCHASES (One-time credit packs)
-- ============================================================
CREATE TABLE credit_purchases (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id),
    
    stripe_payment_intent_id VARCHAR(255) UNIQUE,
    credits_purchased       INTEGER NOT NULL,
    amount_paid             INTEGER NOT NULL, -- cents
    currency                VARCHAR(3) DEFAULT 'usd',
    status                  VARCHAR(20) DEFAULT 'pending'
                            CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
    
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- REFERRALS
-- ============================================================
CREATE TABLE referrals (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_user_id        UUID NOT NULL REFERENCES users(id),
    referred_user_id        UUID REFERENCES users(id),
    
    referral_code           VARCHAR(20) UNIQUE NOT NULL,
    status                  VARCHAR(20) DEFAULT 'pending'
                            CHECK (status IN ('pending', 'completed', 'expired', 'fraudulent')),
    
    referrer_credits_granted BOOLEAN DEFAULT FALSE,
    referred_credits_granted BOOLEAN DEFAULT FALSE,
    
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at            TIMESTAMPTZ
);

CREATE INDEX idx_referrals_code ON referrals(referral_code);
CREATE INDEX idx_referrals_referrer ON referrals(referrer_user_id);

-- ============================================================
-- AUDIT LOG (Team plan)
-- ============================================================
CREATE TABLE audit_log (
    id                      BIGSERIAL PRIMARY KEY,
    organization_id         UUID NOT NULL REFERENCES organizations(id),
    user_id                 UUID NOT NULL REFERENCES users(id),
    
    action                  VARCHAR(50) NOT NULL,
    resource_type           VARCHAR(50),
    resource_id             VARCHAR(255),
    details                 JSONB,
    ip_address              INET,
    
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- 90-day retention via partition management
CREATE TABLE audit_log_2026_q2 PARTITION OF audit_log
    FOR VALUES FROM ('2026-04-01') TO ('2026-07-01');
```

### 10.2 Efficient Usage Queries

**"How much has user X used this month?"**

```sql
-- Fast path: Redis (real-time, sub-millisecond)
-- GET usage:{user_id}:credits:2026-04

-- Accurate path: PostgreSQL
SELECT 
    SUM(CASE WHEN usage_type = 'ai_interaction' THEN credits_consumed ELSE 0 END) AS ai_credits_used,
    SUM(CASE WHEN usage_type = 'compute_session' THEN duration_seconds ELSE 0 END) / 60 AS compute_minutes_used,
    COUNT(CASE WHEN usage_type = 'ai_interaction' THEN 1 END) AS ai_interaction_count
FROM usage_records
WHERE user_id = $1
  AND billing_period = '2026-04';

-- Uses partition pruning (only scans 2026-04 partition)
```

**"What's the credit balance for user X?"**

```sql
-- Fast path: Redis
-- GET usage:{user_id}:credits:{period}
-- Compare against quota:{user_id}:credits_limit

-- Accurate path: use the materialized view
SELECT * FROM credit_balances WHERE user_id = $1;

-- Or compute on-the-fly (more expensive, but always accurate):
SELECT SUM(amount) AS balance
FROM credit_ledger
WHERE user_id = $1;
```

---

## 11. Currency & International Tax

### 11.1 Currency Strategy

**USD only at launch.** Rationale:
- Simplifies accounting and financial reporting
- Stripe handles currency conversion for international cards
- Most SaaS products launch USD-only
- Multi-currency adds significant complexity (price localization, exchange rate management, etc.)

**Future (post-PMF):** Add EUR, GBP, and INR pricing via Stripe's multi-currency support. Use Stripe's Adaptive Pricing to show local currencies at checkout.

### 11.2 Tax Implementation

**Use Stripe Tax for automatic calculation and collection.**

```typescript
// Enable on Checkout Session creation:
{
  automatic_tax: { enabled: true },
  tax_id_collection: { enabled: true },
  // Stripe determines tax based on customer location
  // and product tax code
}

// Product tax code for SaaS:
// txcd_10103000 - "Software as a service (SaaS) - business use"
// Set this on the Stripe Product
```

**What Stripe Tax handles:**
- US state sales tax (nexus detection)
- EU VAT (27 member states)
- UK VAT
- Canadian GST/HST/PST
- Australian GST
- Indian GST
- And 50+ other jurisdictions

**What we must do:**
1. Register for tax in relevant jurisdictions (Stripe tells us where)
2. Set the correct product tax code on each Stripe Product
3. Enable `tax_id_collection` on checkout to collect EU VAT IDs
4. For B2B EU customers with valid VAT IDs: reverse charge applies (0% VAT)
5. Use Stripe Tax's filing integrations (or export reports) for quarterly/annual filings

### 11.3 EU VAT Compliance (ViDA 2026)

Under the EU's VAT in the Digital Age (ViDA) initiative:
- All SaaS companies selling to EU consumers must collect and remit VAT
- The One Stop Shop (OSS) scheme simplifies this to a single registration
- Stripe Tax handles rate calculation and evidence collection automatically
- We must file OSS returns (Stripe provides the data, filing is our responsibility or via Stripe's partner network)

### 11.4 Pricing Display

```
// In UI:
// US customer: "$20/mo"
// EU customer: "$20/mo + VAT" (or "EUR equivalent + VAT")
// UK customer: "$20/mo + VAT"
// Always show tax as separate line item at checkout
```

---

## 12. Anti-Abuse System

### 12.1 Threat Model

| Threat | Severity | Mitigation |
|--------|----------|------------|
| Multiple free accounts (same person) | HIGH | Device fingerprint + email domain + IP clustering |
| Stolen credit cards | HIGH | Stripe Radar + 3DS + velocity checks |
| Chargebacks | MEDIUM | Evidence automation + chargeback-prone user flagging |
| Sign up -> use all credits -> cancel | LOW | Credits are the cost of acquisition; acceptable |
| Bot signups | HIGH | CAPTCHA + email verification + behavioral analysis |
| API abuse (hammering AI endpoints) | HIGH | Rate limiting + anomaly detection |
| Account sharing (password sharing) | LOW | Concurrent session limits |
| Referral fraud (self-referrals) | MEDIUM | Referral validation rules |

### 12.2 Multi-Account Prevention

**Signals collected at signup:**

```typescript
interface SignupSignals {
  email: string;
  emailDomain: string;        // gmail.com, disposable-email.com, etc.
  ipAddress: string;
  ipASN: string;              // Autonomous System Number
  ipIsVPN: boolean;           // Via MaxMind or ipinfo.io
  ipIsDatacenter: boolean;
  deviceFingerprint: string;  // Via FingerprintJS Pro
  browserFingerprint: string; // Canvas, WebGL, fonts hash
  signupTimestamp: Date;
  referralCode?: string;
}
```

**Detection rules:**

```
Rule 1: BLOCK if email domain is in known disposable email list
         (mailinator.com, tempmail.com, etc.)
         Action: Require phone verification

Rule 2: FLAG if deviceFingerprint matches existing user
         Action: Require CAPTCHA + email verification + risk review

Rule 3: FLAG if same IP created > 2 accounts in 24 hours
         Action: Add to review queue, delay credit allocation by 24 hours

Rule 4: FLAG if ipIsVPN AND emailDomain is free provider (gmail, outlook)
         AND no GitHub/Google SSO used
         Action: Require phone verification OR GitHub OAuth

Rule 5: BLOCK if ipIsDatacenter AND no established identity
         Action: Block signup, suggest using personal device

Rule 6: FLAG if email follows pattern: name+{number}@gmail.com
         AND other accounts with same base email exist
         Action: Merge accounts or block
```

**Device Fingerprinting:**

Use FingerprintJS Pro (server-side API) for high-accuracy device identification:
- 99.5% accuracy across browsers
- Survives incognito mode, VPN, cookie clearing
- Identifies returning visitors across sessions
- Cost: ~$0.002/API call (negligible at our scale)

### 12.3 Stripe Radar for Payment Fraud

```typescript
// Enable Stripe Radar (included in Stripe pricing)
// Additional Radar for Fraud Teams: $0.07/screened transaction

// Custom Radar rules for Bricks:
// Block if: card_country != ip_country AND risk_level = 'highest'
// Review if: charge_amount > $200 (unusual for SaaS)
// Block if: card_funding = 'prepaid' AND is_first_charge = true
// Block if: card_bin_country IN (high_fraud_countries) AND risk_score > 70
```

### 12.4 Chargeback Handling

```
charge.dispute.created webhook
        |
        v
1. Immediately flag account (is_disputed = true)
2. Restrict to Free tier (no overage billing while disputed)
3. Auto-submit evidence to Stripe:
   a. IP address logs
   b. Usage records (proof of service delivery)
   c. Account creation date and login history
   d. Device fingerprint match to card owner
4. If dispute is lost:
   a. Mark account as high-risk
   b. If second dispute: suspend account
   c. Block card BIN from future signups
5. If dispute is won:
   a. Restore account to normal
   b. Keep a note in risk profile
```

### 12.5 Rate Limiting

```
Tier-based rate limits:

Free:
  - AI requests: 10/minute, 100/hour
  - API calls: 60/minute
  - File uploads: 10/minute

Pro:
  - AI requests: 30/minute, 500/hour
  - API calls: 300/minute
  - File uploads: 30/minute

Team:
  - AI requests: 60/minute, 1000/hour (per member)
  - API calls: 600/minute (per member)
  - File uploads: 60/minute (per member)

Implementation: Redis sliding window rate limiter
Response: HTTP 429 with Retry-After header
```

### 12.6 Referral Fraud Prevention

```
Rules:
1. Referred user must verify a non-disposable email
2. Referred user must be on a different device fingerprint than referrer
3. Referred user must complete at least 1 AI interaction before credits granted
4. Maximum 10 successful referrals per user
5. Referral credits granted 48 hours after referred user's first interaction
   (gives time for fraud review)
6. If referred user is later flagged as fraudulent: claw back referrer's bonus
```

---

## 13. Flow Diagrams

### 13.1 Complete User Lifecycle

```
                        +-------------------+
                        |   User Signs Up   |
                        |   (via Clerk)     |
                        +---------+---------+
                                  |
                    +-------------v--------------+
                    |  Anti-Abuse Check           |
                    |  (fingerprint, IP, email)   |
                    +-------------+--------------+
                                  |
                        +---------v---------+
                        |  Create User      |
                        |  + Stripe Customer|
                        |  + 200 Free Credits|
                        +---------+---------+
                                  |
                        +---------v---------+
                        |   FREE TIER       |
                        |   Using product   |
                        +---------+---------+
                                  |
                  +---------------+---------------+
                  |                               |
        +---------v---------+           +---------v---------+
        |  Credits run out  |           |  Hits other limit |
        |  (monthly reset   |           |  (projects, etc.) |
        |   or wait)        |           +---------+---------+
        +---------+---------+                     |
                  |                     +---------v---------+
                  |                     |  Upgrade Prompt   |
                  |                     +---------+---------+
                  |                               |
                  +---------------+---------------+
                                  |
                        +---------v---------+
                        |  UPGRADE TO PRO   |
                        |  (Stripe Checkout)|
                        +---------+---------+
                                  |
                  +---------------+---------------+
                  |                               |
        +---------v---------+           +---------v---------+
        |  Payment OK       |           |  Payment Fails    |
        |  Pro activated    |           |  Retry flow       |
        +---------+---------+           +---------+---------+
                  |                               |
                  |                     +---------v---------+
                  |                     |  Grace period     |
                  |                     |  -> Downgrade     |
                  |                     +-------------------+
                  |
        +---------v---------+
        |   PRO TIER        |
        |   Using product   |
        +---------+---------+
                  |
        +---------v---------+
        |  Monthly renewal  |
        |  + credit reset   |
        |  + overage billed |
        +---------+---------+
                  |
        +---------v---------+
        |  Creates Org      |
        |  Upgrades to Team |
        +---------+---------+
                  |
        +---------v---------+
        |   TEAM TIER       |
        |   Shared pool     |
        |   Admin controls  |
        +-------------------+
```

### 13.2 AI Request -- Credit Deduction Flow

```
User sends AI prompt
        |
        v
+-------------------+
| API Gateway       |
| (NestJS Guard)    |
+--------+----------+
         |
         v
+-------------------+     NO     +-------------------+
| Redis: credits    |----------->| Return 402        |
| >= 1 ?            |            | "Out of credits"  |
+--------+----------+            +-------------------+
         | YES
         v
+-------------------+
| Route to AI       |
| Service           |
+--------+----------+
         |
         v
+-------------------+
| Call Claude API   |
| (stream response) |
+--------+----------+
         |
         v
+-------------------+
| Stream to user    |
| via WebSocket     |
+--------+----------+
         |
         v (on stream complete)
+-------------------+
| Calculate credits:|
| input_tokens +    |
| output_tokens*5   |
| / 10000           |
| * model_multiplier|
+--------+----------+
         |
         v
+----------------------------+
| Redis: INCRBYFLOAT         |
| usage:{uid}:credits:{period}|
+--------+-------------------+
         |
         v
+----------------------------+
| Queue: PostgreSQL write    |
| (credit_ledger +           |
|  usage_records)            |
+--------+-------------------+
         |
         v
+----------------------------+     YES    +---------------------+
| Credits > plan limit?      |----------->| Queue: Stripe meter |
|                            |            | event (overage)     |
+--------+-------------------+            +---------------------+
         | NO
         v
+----------------------------+
| Push new balance to client |
| via WebSocket              |
+----------------------------+
```

### 13.3 Stripe Billing Cycle

```
            Day -3                    Day 0                    Day 0+1hr
              |                         |                         |
  +-----------v-----------+  +----------v----------+  +----------v----------+
  | invoice.upcoming      |  | invoice.created     |  | invoice.finalized   |
  | - Flush overage to    |  | - Stripe pulls      |  | - Invoice locked    |
  |   Stripe Meters       |  |   meter summaries   |  | - Payment attempted |
  | - Send usage summary  |  | - Draft invoice     |  |                     |
  |   email to user       |  |   generated         |  |                     |
  +-----------+-----------+  +----------+----------+  +----------+----------+
              |                         |                         |
              |                         |              +----------v----------+
              |                         |              | Payment succeeds?   |
              |                         |              +----+----------+-----+
              |                         |                   |          |
              |                         |              YES  |          | NO
              |                         |                   v          v
              |                         |    +-------------+--+  +----+--------+
              |                         |    | invoice.payment |  | invoice.   |
              |                         |    | _succeeded      |  | payment_   |
              |                         |    | - Allocate new  |  | failed     |
              |                         |    |   credits       |  | - Start    |
              |                         |    | - Reset counters|  |   grace    |
              |                         |    | - Update period |  |   period   |
              |                         |    +-----------------+  +-----------+
```

---

## 14. Edge Cases & Failure Modes

### 14.1 Billing Edge Cases

| Edge Case | Handling |
|-----------|----------|
| User upgrades and downgrades within same day | Stripe proration handles this. We record both events. Credits are prorated both ways. |
| User upgrades right before period end (e.g., day 29 of 30) | Prorated charge is ~$0.67 for 1 day of Pro. Full charge on renewal. Allocate proportional credits (~67 credits). |
| Free user refers 10 people, gets 1,000 bonus credits, never upgrades | This is acceptable. Bonus credits expire in 90 days. The referred users have lifetime value. |
| Team admin removes all members except themselves | Minimum 2 seats enforced. They must downgrade to Pro to go solo. |
| User changes email mid-billing cycle | Clerk handles email change. Sync to Stripe Customer. No billing impact. |
| Stripe webhook arrives out of order (deleted before updated) | Idempotent handlers. Check current state before applying changes. Use Stripe API to fetch latest state if ambiguous. |
| Webhook handler crashes after partial processing | Database transaction ensures atomicity. Failed events are retried. Stripe retries for up to 72 hours. |
| User's timezone vs UTC billing period | All billing is UTC. UI shows "resets on {date}" in user's local timezone. |
| Leap seconds, DST changes | Irrelevant -- Stripe uses Unix timestamps. Our periods are calendar months in UTC. |
| User has both personal and team accounts | Separate Stripe Customers. Personal subscription is independent of team membership. User can choose which context to work in. |
| Subscription created but checkout.session.completed webhook never arrives | Reconciliation job runs every hour: query Stripe for active subscriptions not in our DB. Alert on mismatch. |
| Double-charge (Stripe charges twice) | Stripe handles this internally. If it somehow happens, our idempotent webhook handler ignores the duplicate event. |

### 14.2 Technical Failure Modes

| Failure | Impact | Mitigation |
|---------|--------|------------|
| Redis down | Cannot check quotas in real-time | Fallback: query PostgreSQL (slower). Allow requests with 5-minute grace while Redis recovers. Circuit breaker pattern. |
| PostgreSQL down | Cannot record usage | Queue writes in Redis. Replay when DB recovers. No usage is lost. |
| Stripe API down | Cannot create subscriptions or report usage | Queue operations. Stripe meter events can be backdated up to 35 days. Subscription changes queued and retried. |
| Stripe webhook endpoint down | Missed events | Stripe retries for 72 hours. We run a reconciliation job that fetches missed events via Stripe API. |
| AI API down (Claude) | Users can't use AI features | Credits not deducted (deduct on completion). Show error in UI. No billing impact. |
| Usage worker crashes | Overage not reported to Stripe | Worker uses persistent queue (Redis Streams or BullMQ). Unprocessed jobs are retried on restart. |
| Credit balance goes negative | Potential revenue loss | Capped at -10 for free users. Paid users: negative balance = overage, billed normally. |
| Clock skew between services | Usage timestamps slightly off | Use server-side timestamps only. Never trust client timestamps for billing. Stripe allows 5-minute future tolerance. |

### 14.3 Concurrency Edge Cases

| Scenario | Handling |
|----------|----------|
| Two AI requests from same user arrive simultaneously | Redis INCRBYFLOAT is atomic. Both deductions apply. If this causes overdraft, handled by overdraft policy. |
| User upgrades while an AI request is in-flight | Request completes under old plan pricing. New credits applied immediately. No double-charging. |
| Admin removes team member while member has active session | Session continues until natural end. Member reverts to personal free account. |
| Two admins add seats simultaneously | Stripe handles this -- last write wins. Our webhook handler uses the subscription state from Stripe (source of truth). |

---

## 15. Appendix: Stripe Object Mapping

### 15.1 Bricks <-> Stripe Entity Mapping

```
Bricks Entity          Stripe Entity           Relationship
--------------         ---------------         ---------------
User (individual)      Customer                1:1
Organization           Customer                1:1
Free Plan              Product + Price          Shared across customers
Pro Plan               Product + Price          Shared across customers
Team Plan              Product + Price          Shared across customers
Credit Overage         Meter + Price            Per-meter
Compute Overage        Meter + Price            Per-meter
Credit Pack            Product + Price          One-time charge
Monthly billing        Subscription             1:1 per customer
Usage report           Meter Event              Many per customer
Invoice                Invoice                  Generated by Stripe
Tax                    Stripe Tax               Automatic
Payment                PaymentIntent            Per invoice
Refund                 Refund                   Per PaymentIntent
```

### 15.2 Stripe Dashboard Configuration Checklist

```
[ ] Create Products:
    [ ] Bricks Free
    [ ] Bricks Pro
    [ ] Bricks Team
    [ ] Bricks Credit Pack (300)
    [ ] Bricks Credit Pack (1000)
    [ ] Bricks Credit Pack (3000)

[ ] Create Prices:
    [ ] Free: $0/month
    [ ] Pro: $20/month (recurring)
    [ ] Pro Credit Overage: $0.05/credit (metered)
    [ ] Pro Compute Overage: $0.005/minute (metered)
    [ ] Team: $50/seat/month (recurring, per_unit)
    [ ] Team Credit Overage: $0.05/credit (metered)
    [ ] Team Compute Overage: $0.004/minute (metered)
    [ ] Credit Pack 300: $5 (one-time)
    [ ] Credit Pack 1000: $15 (one-time)
    [ ] Credit Pack 3000: $40 (one-time)

[ ] Create Meters:
    [ ] bricks_credit_overage (sum aggregation)
    [ ] bricks_compute_overage (sum aggregation)

[ ] Configure Stripe Tax:
    [ ] Enable automatic tax
    [ ] Set tax code: txcd_10103000 (SaaS - business use)
    [ ] Register in required jurisdictions
    [ ] Enable VAT ID collection

[ ] Configure Stripe Radar:
    [ ] Enable Radar
    [ ] Add custom rules for SaaS patterns
    [ ] Set up Radar for Fraud Teams (if budget allows)

[ ] Configure Webhooks:
    [ ] Set endpoint URL: https://api.bricks.dev/webhooks/stripe
    [ ] Select events (see Section 5.1)
    [ ] Store webhook signing secret securely

[ ] Configure Customer Portal:
    [ ] Enable self-service subscription management
    [ ] Enable payment method updates
    [ ] Enable invoice history
    [ ] Configure cancellation flow with survey

[ ] Configure Smart Retries:
    [ ] Retry schedule: Day 0, Day 3, Day 5, Day 7
    [ ] Enable Smart Retries (ML-optimized timing)

[ ] Test Mode:
    [ ] Verify all flows with test cards
    [ ] Test webhook handling end-to-end
    [ ] Test proration scenarios
    [ ] Test payment failure -> grace period -> downgrade
    [ ] Test overage billing cycle
```

### 15.3 Environment Variables

```env
# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Stripe Price IDs
STRIPE_PRICE_FREE=price_free_...
STRIPE_PRICE_PRO=price_pro_monthly_...
STRIPE_PRICE_PRO_CREDIT_OVERAGE=price_pro_credit_overage_...
STRIPE_PRICE_PRO_COMPUTE_OVERAGE=price_pro_compute_overage_...
STRIPE_PRICE_TEAM_SEAT=price_team_seat_...
STRIPE_PRICE_TEAM_CREDIT_OVERAGE=price_team_credit_overage_...
STRIPE_PRICE_TEAM_COMPUTE_OVERAGE=price_team_compute_overage_...
STRIPE_PRICE_CREDIT_PACK_300=price_pack_300_...
STRIPE_PRICE_CREDIT_PACK_1000=price_pack_1000_...
STRIPE_PRICE_CREDIT_PACK_3000=price_pack_3000_...

# Stripe Meter IDs
STRIPE_METER_CREDIT_OVERAGE=mtr_credit_...
STRIPE_METER_COMPUTE_OVERAGE=mtr_compute_...

# Stripe Product IDs
STRIPE_PRODUCT_FREE=prod_free_...
STRIPE_PRODUCT_PRO=prod_pro_...
STRIPE_PRODUCT_TEAM=prod_team_...

# Redis
REDIS_URL=redis://...

# FingerprintJS
FINGERPRINTJS_API_KEY=...
FINGERPRINTJS_SECRET=...
```

---

## Design Decisions Log

| Decision | Choice | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Credit unit | 1 credit = 10K weighted tokens | 1:1 token mapping, flat per-request pricing | User-friendly abstraction. Hides complexity of token pricing. Allows future adjustment without user-facing changes. |
| Deduction timing | On completion | On start, on start with refund | Simpler (no refund logic). Better UX (no charge for failures). Small abuse vector (capped by overdraft limit). |
| Stripe Checkout vs embedded | Stripe Checkout | Stripe Elements, custom form | PCI scope reduction. Built-in tax collection. Mobile optimization. Less code. |
| Usage source of truth | PostgreSQL | Stripe, Redis | Stripe is write-only for meter events. Redis is volatile. PostgreSQL gives full auditability and query flexibility. |
| Real-time quota check | Redis | PostgreSQL, in-memory | Sub-millisecond latency. Atomic operations. TTL for auto-cleanup. Handles high concurrency. |
| Team billing model | Shared pool with soft per-member limits | Hard per-member limits, unlimited pool | Flexible for real team usage patterns. Admin controls for those who want hard limits. |
| Free tier overdraft | Pre-check + allow with cap (10 credits) | Hard cutoff, no overdraft | Pre-check blocks if remaining < minimum model cost. Better UX. Cost is negligible. Prevents mid-response cutoff. |
| Multi-currency | USD only at launch | Multi-currency from day 1 | Simplicity. International cards handled by Stripe. Add currencies post-PMF. |
| Tax handling | Stripe Tax | Build own tax engine, Avalara, TaxJar | Lowest integration effort. Single vendor (Stripe). Supports 50+ jurisdictions. |
| Webhook idempotency | Event ID in database | Stripe-Idempotency-Key header, in-memory cache | Persistent. Survives restarts. Audit trail. |
| Usage record partitioning | Monthly range partitions | No partitioning, weekly, hash | Monthly aligns with billing periods. Easy to archive old data. Good query performance for monthly aggregations. |

---

## Implementation Priority

### Phase 1 (MVP -- Week 1-2)
- [ ] Stripe Customer creation on signup
- [ ] Free tier with 100 credits
- [ ] Credit ledger (PostgreSQL)
- [ ] Basic quota check (Redis)
- [ ] AI credit deduction on completion
- [ ] Simple usage display in UI

### Phase 2 (Monetization -- Week 3-4)
- [ ] Pro plan with Stripe Checkout
- [ ] Webhook handler (core events)
- [ ] Overage metering via Stripe Meters
- [ ] Payment failure handling
- [ ] Billing dashboard (individual)

### Phase 3 (Teams -- Week 5-6)
- [ ] Organization model
- [ ] Team billing with per-seat pricing
- [ ] Shared credit pool
- [ ] Admin dashboard
- [ ] Seat management

### Phase 4 (Hardening -- Week 7-8)
- [ ] Anti-abuse system (fingerprinting, risk scoring)
- [ ] Stripe Tax integration
- [ ] Referral system
- [ ] Credit packs (one-time purchases)
- [ ] Reconciliation jobs
- [ ] Comprehensive webhook handling
- [ ] Audit logging

### Phase 5 (Polish -- Week 9-10)
- [ ] Usage export (CSV)
- [ ] Stripe Customer Portal integration
- [ ] Pause/resume subscriptions
- [ ] Advanced admin controls
- [ ] Usage alerts and notifications
- [ ] Load testing billing system

---

*This document is the billing system blueprint for Bricks. Every Stripe webhook, database write, and credit calculation described here must be implemented with idempotency, atomicity, and auditability. Billing bugs are revenue bugs -- test every edge case.*
