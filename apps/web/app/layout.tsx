import "@workspace/ui/globals.css"

import { cn } from "@workspace/ui/lib/utils"
import { Geist_Mono, Inter } from "next/font/google"
import { headers } from "next/headers"
import { connection } from "next/server"
import { AppShell } from "@/components/app-shell"
import { ThemeProvider } from "@/components/theme-provider"
import { TRPCReactProvider } from "@/lib/trpc/client"
import { HydrateClient } from "@/lib/trpc/hydrate"

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" })

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

/**
 * Nonce-based CSP (proxy.ts) requires this tree to render dynamically: the
 * proxy nonce travels through the request CSP header, and Next applies it to
 * inline scripts only while SSR-ing a dynamic document. The nonce also feeds
 * next-themes' inline bootstrap so theme flash-prevention survives the
 * tightened script policy.
 */
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  await connection()
  const nonce = (await headers()).get("x-nonce") ?? undefined

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        fontMono.variable,
        "font-sans",
        inter.variable
      )}
    >
      <body>
        <ThemeProvider nonce={nonce}>
          <TRPCReactProvider>
            <HydrateClient>
              <AppShell>{children}</AppShell>
            </HydrateClient>
          </TRPCReactProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
