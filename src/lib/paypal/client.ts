// ─── PayPal REST API Client ──────────────────────────────────────────────────

const PAYPAL_BASE_URL =
  process.env.NODE_ENV === "production"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

/**
 * Fetch a short-lived OAuth2 access token from PayPal.
 * Uses Basic auth with PAYPAL_CLIENT_ID:PAYPAL_CLIENT_SECRET.
 */
export async function getAccessToken(): Promise<string> {
  const clientId = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("PayPal credentials are not configured");
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal OAuth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.access_token as string;
}

/**
 * Verify a webhook signature with the PayPal API.
 * Returns true if the webhook is genuine, false otherwise.
 */
export async function verifyWebhookSignature(
  headers: Record<string, string>,
  body: string
): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    throw new Error("PAYPAL_WEBHOOK_ID is not configured");
  }

  const accessToken = await getAccessToken();

  const verificationPayload = {
    auth_algo: headers["paypal-auth-algo"],
    cert_url: headers["paypal-cert-url"],
    transmission_id: headers["paypal-transmission-id"],
    transmission_sig: headers["paypal-transmission-sig"],
    transmission_time: headers["paypal-transmission-time"],
    webhook_id: webhookId,
    webhook_event: JSON.parse(body),
  };

  const res = await fetch(
    `${PAYPAL_BASE_URL}/v1/notifications/verify-webhook-signature`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(verificationPayload),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    console.error(`PayPal webhook verification request failed (${res.status}): ${text}`);
    return false;
  }

  const data = await res.json();
  return data.verification_status === "SUCCESS";
}

/**
 * Fetch full subscription details from PayPal.
 */
export async function getSubscriptionDetails(
  subscriptionId: string
): Promise<PayPalSubscription> {
  const accessToken = await getAccessToken();

  const res = await fetch(
    `${PAYPAL_BASE_URL}/v1/billing/subscriptions/${subscriptionId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `PayPal get subscription failed (${res.status}): ${text}`
    );
  }

  return res.json() as Promise<PayPalSubscription>;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PayPalSubscription {
  id: string;
  plan_id: string;
  status: string;
  custom_id?: string;
  start_time?: string;
  billing_info?: {
    next_billing_time?: string;
    last_payment?: {
      amount?: {
        currency_code: string;
        value: string;
      };
      time?: string;
    };
    cycle_executions?: Array<{
      tenure_type: string;
      sequence: number;
      cycles_completed: number;
      cycles_remaining: number;
      current_pricing_scheme_version: number;
      total_cycles: number;
    }>;
  };
  subscriber?: {
    email_address?: string;
    name?: {
      given_name?: string;
      surname?: string;
    };
  };
  create_time?: string;
  update_time?: string;
}
