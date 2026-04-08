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

    // Prevent CloudFront / any CDN from caching authenticated app routes.
    // These are dynamic, user-specific pages that must never be served from
    // a shared cache.  s-maxage=0 tells the CDN not to cache; no-store
    // tells the browser not to cache; must-revalidate ensures stale content
    // is never used.
    const noCacheHeaders = [
      {
        key: "Cache-Control",
        value:
          "private, no-cache, no-store, max-age=0, s-maxage=0, must-revalidate",
      },
      { key: "Pragma", value: "no-cache" },
      { key: "Expires", value: "0" },
    ];

    return [
      // WebContainer routes get COOP/COEP + no-cache
      {
        source: "/chat/:path*",
        headers: [...coopCoepHeaders, ...noCacheHeaders],
      },
      {
        source: "/build/:path*",
        headers: [...coopCoepHeaders, ...noCacheHeaders],
      },
      // Other authenticated app routes — no-cache only
      { source: "/settings/:path*", headers: noCacheHeaders },
      { source: "/pricing", headers: noCacheHeaders },
      // API routes — prevent CDN caching of dynamic API responses
      { source: "/api/:path*", headers: noCacheHeaders },
    ];
  },
  turbopack: {},
};

export default nextConfig;
