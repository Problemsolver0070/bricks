import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getUserByClerkId } from "@/lib/db/queries";
import { uploadBlob } from "@/lib/storage/azure-blob";
import {
  type Attachment,
  detectCategory,
  isAllowedFile,
  MAX_FILE_SIZE,
  MAX_FILES_PER_UPLOAD,
} from "@/lib/types/attachment";

export async function POST(req: NextRequest) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await getUserByClerkId(clerkId);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const formData = await req.formData();
    const files = formData.getAll("files") as File[];

    if (files.length === 0) {
      return NextResponse.json(
        { error: "No files provided" },
        { status: 400 }
      );
    }

    if (files.length > MAX_FILES_PER_UPLOAD) {
      return NextResponse.json(
        { error: `Maximum ${MAX_FILES_PER_UPLOAD} files per upload` },
        { status: 400 }
      );
    }

    const attachments: Attachment[] = [];

    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `File "${file.name}" exceeds 25 MB limit` },
          { status: 413 }
        );
      }

      if (!isAllowedFile(file.type, file.name)) {
        return NextResponse.json(
          { error: `File type "${file.type}" is not supported` },
          { status: 415 }
        );
      }

      const id = crypto.randomUUID();
      const blobKey = `uploads/${user.id}/${id}/${file.name}`;
      const buffer = Buffer.from(await file.arrayBuffer());
      const blobUrl = await uploadBlob(blobKey, buffer, file.type);
      const category = detectCategory(file.type, file.name);

      attachments.push({
        id,
        filename: file.name,
        mimeType: file.type,
        size: file.size,
        blobUrl,
        blobKey,
        category,
      });
    }

    return NextResponse.json({ attachments });
  } catch (error) {
    console.error("POST /api/upload error:", error);
    return NextResponse.json(
      { error: "Upload failed" },
      { status: 500 }
    );
  }
}
