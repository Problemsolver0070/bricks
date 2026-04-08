import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks(.*)",
  "/pricing",
]);

// Routes that should never be cached by the CDN or browser.
// These are user-specific / authenticated pages.
const isNoCacheRoute = createRouteMatcher([
  "/chat(.*)",
  "/build(.*)",
  "/settings(.*)",
  "/pricing",
  "/api/(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }

  const response = NextResponse.next();

  // Inject no-cache headers for authenticated / dynamic routes so CloudFront
  // and downstream CDN edges never serve stale (or stale 404) responses.
  if (isNoCacheRoute(request)) {
    response.headers.set(
      "Cache-Control",
      "private, no-cache, no-store, max-age=0, s-maxage=0, must-revalidate"
    );
    response.headers.set("Pragma", "no-cache");
    response.headers.set("Expires", "0");
  }

  return response;
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
