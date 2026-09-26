import type { NextConfig } from "next"

const isDevelopment = process.env.NODE_ENV === "development"
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
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

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
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
    ]
  },
}

export default nextConfig
