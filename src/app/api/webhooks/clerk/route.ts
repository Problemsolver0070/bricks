import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { NextRequest, NextResponse } from "next/server";
import { createUser } from "@/lib/db/queries";

export async function POST(req: NextRequest) {
  try {
    const evt = await verifyWebhook(req);

    if (evt.type === "user.created") {
      const { id, email_addresses, first_name, last_name, image_url } =
        evt.data;

      const primaryEmail = email_addresses?.[0]?.email_address;
      if (!primaryEmail) {
        return NextResponse.json(
          { error: "No email address found" },
          { status: 400 }
        );
      }

      const name = [first_name, last_name].filter(Boolean).join(" ") || null;

      await createUser({
        clerkId: id,
        email: primaryEmail,
        name: name ?? undefined,
        avatarUrl: image_url ?? undefined,
      });
    }

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (err) {
    console.error("Clerk webhook verification failed:", err);
    return NextResponse.json(
      { error: "Webhook verification failed" },
      { status: 400 }
    );
  }
}
