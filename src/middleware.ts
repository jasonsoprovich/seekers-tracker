import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// OpenNext currently supports Edge Middleware but not Next.js 16's
// Node-runtime proxy convention. Keep this narrow: authorization remains in
// the app layout; this only gives its login redirect the original URL.
export function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-seekers-return-to", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: [
    "/admin/:path*",
    "/bank/:path*",
    "/bootstrap-leader/:path*",
    "/characters/:path*",
    "/dashboard/:path*",
    "/epgp/:path*",
    "/live-bids/:path*",
    "/profile/:path*",
    "/progression/:path*",
    "/roster/:path*",
  ],
};
