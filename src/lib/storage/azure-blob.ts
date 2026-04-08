import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  SASProtocol,
} from "@azure/storage-blob";

let _blobServiceClient: BlobServiceClient | null = null;

function getBlobServiceClient(): BlobServiceClient {
  if (!_blobServiceClient) {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error("AZURE_STORAGE_CONNECTION_STRING not configured");
    }
    _blobServiceClient =
      BlobServiceClient.fromConnectionString(connectionString);
  }
  return _blobServiceClient;
}

function getContainerName(): string {
  return process.env.AZURE_STORAGE_CONTAINER || "uploads";
}

export async function uploadBlob(
  blobKey: string,
  data: Buffer,
  contentType: string
): Promise<string> {
  const client = getBlobServiceClient();
  const container = client.getContainerClient(getContainerName());
  const blockBlob = container.getBlockBlobClient(blobKey);

  await blockBlob.uploadData(data, {
    blobHTTPHeaders: { blobContentType: contentType },
  });

  return blockBlob.url;
}

export async function downloadBlob(blobKey: string): Promise<Buffer> {
  const client = getBlobServiceClient();
  const container = client.getContainerClient(getContainerName());
  const blockBlob = container.getBlockBlobClient(blobKey);

  const response = await blockBlob.download(0);
  const chunks: Buffer[] = [];

  if (response.readableStreamBody) {
    for await (const chunk of response.readableStreamBody) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  }

  return Buffer.concat(chunks);
}

export function generateSasUrl(blobKey: string): string {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING!;
  const accountName = connectionString.match(/AccountName=([^;]+)/)?.[1];
  const accountKey = connectionString.match(/AccountKey=([^;]+)/)?.[1];

  if (!accountName || !accountKey) {
    throw new Error("Could not parse storage account credentials");
  }

  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  const containerName = getContainerName();

  const expiresOn = new Date();
  expiresOn.setHours(expiresOn.getHours() + 1);

  const sas = generateBlobSASQueryParameters(
    {
      containerName,
      blobName: blobKey,
      permissions: BlobSASPermissions.parse("r"),
      expiresOn,
      protocol: SASProtocol.Https,
    },
    credential
  ).toString();

  return `https://${accountName}.blob.core.windows.net/${containerName}/${blobKey}?${sas}`;
}
