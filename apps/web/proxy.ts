import { type NextRequest, NextResponse } from "next/server"

/**
 * Per-request nonce-based Content-Security-Policy (production web hardening).
 *
 * Every document request gets a fresh nonce; Next.js parses the request CSP
 * header during SSR and applies the nonce to its framework and page scripts
 * automatically, so inline scripts no longer rely on 'unsafe-inline'. The
 * upstream CSP guide documents this proxy pattern (docs: content-security-policy).
 *
 * Scope notes:
 * - Document requests only. Static assets, image optimization, and the
 *   proxied API surface (/api is rewritten to the NestJS API container, and
 *   Better Auth routes must stay auditable) never receive document CSP.
 * - Link prefetches skip CSP spend; they do not render documents.
 * - style-src keeps 'unsafe-inline' (style attributes across the UI shell) —
 *   only script-src is tightened; the strictness lives where execution risk
 *   is.
 * - 'strict-dynamic' propagates trust from the nonced bootstrap to scripts
 *   the framework loads itself; 'self' stays for legacy browsers that do not
 *   implement it.
 * - Dynamic rendering is forced at the root layout (connection()), which is a
 *   requirement for nonce injection into SSR documents.
 */

function documentSecurityPolicy(nonce: string): string {
  const isDevelopment = process.env.NODE_ENV === "development"
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${isDevelopment ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    ...(!isDevelopment ? ["upgrade-insecure-requests"] : []),
  ].join("; ")
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64")

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set("Content-Security-Policy", documentSecurityPolicy(nonce))

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  })
  response.headers.set("Content-Security-Policy", documentSecurityPolicy(nonce))
  return response
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
}
