import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@workspace/ui", "api"],
  async rewrites() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
    return [
      { source: "/api/trpc/:path*", destination: `${apiUrl}/api/trpc/:path*` },
      { source: "/api/auth/:path*", destination: `${apiUrl}/api/auth/:path*` },
    ]
  },
}

export default nextConfig
