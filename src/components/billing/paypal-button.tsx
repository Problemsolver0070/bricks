"use client";

import { useCallback, useState } from "react";
import {
  PayPalScriptProvider,
  PayPalButtons,
} from "@paypal/react-paypal-js";

interface PayPalSubscribeButtonProps {
  planId: string;
  userId: string;
  onSuccess: (subscriptionId: string) => void;
}

export function PayPalSubscribeButton({
  planId,
  userId,
  onSuccess,
}: PayPalSubscribeButtonProps) {
  const [error, setError] = useState<string | null>(null);

  const clientId = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID;

  if (!clientId) {
    return (
      <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
        PayPal is not configured. Please set NEXT_PUBLIC_PAYPAL_CLIENT_ID.
      </div>
    );
  }

  return (
    <PayPalScriptProvider
      options={{
        clientId,
        vault: true,
        intent: "subscription",
      }}
    >
      <div className="w-full">
        {error && (
          <div className="mb-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <PayPalButtons
          style={{
            shape: "rect",
            color: "gold",
            layout: "vertical",
            label: "subscribe",
          }}
          createSubscription={(_data, actions) => {
            setError(null);
            return actions.subscription.create({
              plan_id: planId,
              custom_id: userId,
            });
          }}
          onApprove={async (data) => {
            if (data.subscriptionID) {
              onSuccess(data.subscriptionID);
            }
          }}
          onError={(err) => {
            console.error("PayPal error:", err);
            setError(
              "Something went wrong with PayPal. Please try again."
            );
          }}
          onCancel={() => {
            setError(null);
          }}
        />
      </div>
    </PayPalScriptProvider>
  );
}
