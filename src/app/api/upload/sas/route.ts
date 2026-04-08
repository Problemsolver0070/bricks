import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getOrCreateUserByClerkId } from "@/lib/db/queries";
import { generateSasUrl } from "@/lib/storage/azure-blob";

export async function GET(req: NextRequest) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await getOrCreateUserByClerkId(clerkId);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const blobKey = req.nextUrl.searchParams.get("blobKey");
    if (!blobKey) {
      return NextResponse.json(
        { error: "blobKey parameter required" },
        { status: 400 }
      );
    }

    // Security: verify the blob belongs to this user and no path traversal
    if (blobKey.includes("..") || !blobKey.startsWith(`uploads/${user.id}/`)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = generateSasUrl(blobKey);
    return NextResponse.json({ url });
  } catch (error) {
    console.error("GET /api/upload/sas error:", error);
    return NextResponse.json(
      { error: "Failed to generate SAS URL" },
      { status: 500 }
    );
  }
}
