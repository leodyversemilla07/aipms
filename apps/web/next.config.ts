import type { NextConfig } from "next"

const isDevelopment = process.env.NODE_ENV === "development"

/**
 * Document-level security headers. The Content-Security-Policy itself is not
 * set here: apps/web/proxy.ts issues a per-request nonce-based CSP (Next.js
 * applies request-header CSP nonces to inline scripts only in dynamically
 * rendered documents), so this static list covers everything around it. The
 * source excludes /api/auth so IdP-controlled SAML POST forms keep rendering
 * without document CSP (audited auth flow, §8.5).
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  ...(!isDevelopment
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=31536000; includeSubDomains",
        },
      ]
    : []),
]

const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@workspace/ui", "api"],
  async headers() {
    return [
      {
        // Auth callbacks may return IdP-controlled SAML POST forms. Apply CSP
        // to application documents without blocking that audited auth flow.
        source: "/((?!api/auth|_next/static|_next/image|favicon.ico).*)",
        headers: securityHeaders,
      },
    ]
  },
  async rewrites() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
    return [
      { source: "/api/trpc/:path*", destination: `${apiUrl}/api/trpc/:path*` },
      { source: "/api/auth/:path*", destination: `${apiUrl}/api/auth/:path*` },
      // OAuth must return to this origin so the browser sends its auth cookie.
      {
        source: "/api/erp/qbo/callback",
        destination: `${apiUrl}/api/erp/qbo/callback`,
      },
    ]
  },
}

export default nextConfig
