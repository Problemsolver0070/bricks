import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature, getSubscriptionDetails } from "@/lib/paypal/client";
import { upsertSubscription, updateUserPlan, getSubscription } from "@/lib/db/queries";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();

    // Collect PayPal signature headers
    const headers: Record<string, string> = {};
    const paypalHeaders = [
      "paypal-auth-algo",
      "paypal-cert-url",
      "paypal-transmission-id",
      "paypal-transmission-sig",
      "paypal-transmission-time",
    ];
    for (const key of paypalHeaders) {
      const value = req.headers.get(key);
      if (value) headers[key] = value;
    }

    // Verify the webhook signature
    const isValid = await verifyWebhookSignature(headers, body);
    if (!isValid) {
      console.error("PayPal webhook signature verification failed");
      return NextResponse.json(
        { error: "Invalid webhook signature" },
        { status: 401 }
      );
    }

    const event = JSON.parse(body);
    const eventType: string = event.event_type;
    const resource = event.resource;

    console.log(`PayPal webhook received: ${eventType}`);

    switch (eventType) {
      case "BILLING.SUBSCRIPTION.ACTIVATED": {
        await handleSubscriptionActivated(resource);
        break;
      }

      case "BILLING.SUBSCRIPTION.CANCELLED":
      case "BILLING.SUBSCRIPTION.SUSPENDED": {
        await handleSubscriptionDeactivated(resource, eventType);
        break;
      }

      case "PAYMENT.SALE.COMPLETED": {
        await handlePaymentCompleted(resource);
        break;
      }

      default: {
        console.log(`Unhandled PayPal event type: ${eventType}`);
      }
    }

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (err) {
    console.error("PayPal webhook error:", err);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}

// ─── Event Handlers ──────────────────────────────────────────────────────────

async function handleSubscriptionActivated(resource: PayPalWebhookResource) {
  const paypalSubscriptionId = resource.id;
  const userId = resource.custom_id;

  if (!userId || !paypalSubscriptionId) {
    console.error("Missing custom_id or subscription id in ACTIVATED event");
    return;
  }

  // Fetch full subscription details for billing period info
  let periodStart: Date | undefined;
  let periodEnd: Date | undefined;

  try {
    const details = await getSubscriptionDetails(paypalSubscriptionId);
    if (details.start_time) {
      periodStart = new Date(details.start_time);
    }
    if (details.billing_info?.next_billing_time) {
      periodEnd = new Date(details.billing_info.next_billing_time);
    }
  } catch (err) {
    console.error("Failed to fetch subscription details:", err);
  }

  await upsertSubscription({
    userId,
    paypalSubscriptionId,
    plan: "pro",
    status: "active",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });

  await updateUserPlan(userId, "pro");

  console.log(`Subscription activated for user ${userId}`);
}

async function handleSubscriptionDeactivated(
  resource: PayPalWebhookResource,
  eventType: string
) {
  const paypalSubscriptionId = resource.id;
  const userId = resource.custom_id;

  if (!userId || !paypalSubscriptionId) {
    console.error(`Missing custom_id or subscription id in ${eventType} event`);
    return;
  }

  const status =
    eventType === "BILLING.SUBSCRIPTION.CANCELLED" ? "cancelled" : "suspended";

  await upsertSubscription({
    userId,
    paypalSubscriptionId,
    plan: "pro",
    status,
  });

  // Only downgrade plan if cancelled (suspended might be retried)
  if (status === "cancelled") {
    await updateUserPlan(userId, "trial");
  }

  console.log(`Subscription ${status} for user ${userId}`);
}

async function handlePaymentCompleted(resource: PayPalWebhookResource) {
  // Payment sale events have billing_agreement_id pointing to the subscription
  const billingAgreementId = resource.billing_agreement_id;

  if (!billingAgreementId) {
    // Not a subscription payment, ignore
    return;
  }

  // Look up which user has this PayPal subscription
  let userId: string | undefined;

  try {
    const details = await getSubscriptionDetails(billingAgreementId);
    userId = details.custom_id;
  } catch {
    // Fallback: look up by paypal subscription id in our DB
    console.error("Failed to fetch subscription details for payment event");
  }

  if (!userId) {
    // Try to find from our database
    const existingSub = await findSubscriptionByPaypalId(billingAgreementId);
    if (existingSub) {
      userId = existingSub.userId;
    }
  }

  if (!userId) {
    console.error(
      `Could not resolve user for payment on subscription ${billingAgreementId}`
    );
    return;
  }

  // Extend the billing period
  const now = new Date();
  const nextPeriodEnd = new Date(now);
  nextPeriodEnd.setMonth(nextPeriodEnd.getMonth() + 1);

  await upsertSubscription({
    userId,
    paypalSubscriptionId: billingAgreementId,
    plan: "pro",
    status: "active",
    currentPeriodStart: now,
    currentPeriodEnd: nextPeriodEnd,
  });

  await updateUserPlan(userId, "pro");

  console.log(`Payment completed for user ${userId}, period extended`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function findSubscriptionByPaypalId(paypalSubscriptionId: string) {
  const { subscriptions } = await import("@/lib/db/schema");
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.paypalSubscriptionId, paypalSubscriptionId));
  return sub ?? null;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface PayPalWebhookResource {
  id?: string;
  custom_id?: string;
  billing_agreement_id?: string;
  status?: string;
  [key: string]: unknown;
}
