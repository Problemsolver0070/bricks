import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Inline env vars into ALL bundles (including Edge middleware) at build time.
  // Amplify sets these as build-time env vars in the console, but the Edge
  // runtime cannot read .env.production at runtime — values must be baked in.
  env: {
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_CLERK_SIGN_IN_URL: process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL,
    NEXT_PUBLIC_CLERK_SIGN_UP_URL: process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL,
  },
  async headers() {
    // COEP/COOP headers are required by the WebContainer API but block
    // Clerk's cross-origin auth resources. Scope them to the routes that
    // actually use WebContainers (/chat and /build).
    const coopCoepHeaders = [
      {
        key: "Cross-Origin-Embedder-Policy",
        value: "credentialless",
      },
      {
        key: "Cross-Origin-Opener-Policy",
        value: "same-origin",
      },
    ];

    return [
      { source: "/chat/:path*", headers: coopCoepHeaders },
      { source: "/build/:path*", headers: coopCoepHeaders },
    ];
  },
  turbopack: {},
};

export default nextConfig;
