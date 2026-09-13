import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function proxy(request: NextRequest) {
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
