import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@workspace/ui", "api"],
  // Dev-only: the E2E suite drives the desk over 127.0.0.1 while `next dev`
  // defaults its allowed origins to localhost.
  allowedDevOrigins: ["127.0.0.1"],
  async rewrites() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
    return [
      { source: "/api/trpc/:path*", destination: `${apiUrl}/api/trpc/:path*` },
      { source: "/api/auth/:path*", destination: `${apiUrl}/api/auth/:path*` },
    ]
  },
}

export default nextConfig
