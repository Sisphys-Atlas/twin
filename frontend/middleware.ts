import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PATHS = ["/login"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths through
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    // If already authenticated and hitting /login, redirect to agent
    const token = request.cookies.get("twin_token")?.value;
    if (token) {
      return NextResponse.redirect(new URL("/agent", request.url));
    }
    return NextResponse.next();
  }

  // All other paths require the auth cookie
  const token = request.cookies.get("twin_token")?.value;
  if (!token) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Run on page routes only — exclude Next.js internals, static files, and API proxy routes
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.png$|api/).*)"],
};
