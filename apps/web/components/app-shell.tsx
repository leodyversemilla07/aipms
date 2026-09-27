"use client"

import { useQuery } from "@tanstack/react-query"
import { authClient } from "@workspace/auth/client"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@workspace/ui/components/sidebar"
import {
  ClipboardListIcon,
  DatabaseIcon,
  FileClockIcon,
  InboxIcon,
  LayoutDashboardIcon,
  RotateCcwIcon,
  WalletIcon,
} from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { ReactNode } from "react"
import { SignOutButton } from "@/components/sign-out-button"
import { useTRPC } from "@/lib/trpc/client"

const pageSections: Record<string, string> = {
  "/": "Overview",
  "/procurement": "Procurement",
  "/finance": "Finance",
  "/intake": "Intake",
  "/audit": "Audit",
  "/master-data": "Master data",
  "/operations": "Recovery",
  "/sso": "Identity",
}

const desks = [
  { title: "Overview", href: "/", icon: LayoutDashboardIcon, roles: [] },
  {
    title: "Procurement",
    href: "/procurement",
    icon: ClipboardListIcon,
    roles: ["procurement", "finance", "admin"],
  },
  {
    title: "Finance",
    href: "/finance",
    icon: WalletIcon,
    roles: ["finance", "admin"],
  },
  {
    title: "Intake",
    href: "/intake",
    icon: InboxIcon,
    roles: ["finance", "admin"],
  },
  {
    title: "Audit",
    href: "/audit",
    icon: FileClockIcon,
    roles: ["finance", "admin"],
  },
  {
    title: "Master data",
    href: "/master-data",
    icon: DatabaseIcon,
    roles: ["procurement", "finance", "admin"],
  },
  {
    title: "Recovery",
    href: "/operations",
    icon: RotateCcwIcon,
    roles: ["finance", "admin"],
  },
] as const

function AppSidebar({ email, role }: { email: string; role?: string }) {
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()

  return (
    <Sidebar collapsible="icon" aria-label="Desks">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              render={<Link href="/" onClick={() => setOpenMobile(false)} />}
              title="AIPMS overview"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-sidebar-primary font-semibold text-sidebar-primary-foreground">
                A
              </span>
              <span className="flex flex-col leading-tight">
                <strong>AIPMS</strong>
                <span className="text-sidebar-foreground/70 text-xs">
                  Supervisory desk
                </span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label="Desks">
              <SidebarMenu>
                {desks
                  .filter(
                    (desk) =>
                      desk.roles.length === 0 ||
                      desk.roles.some((allowed) => allowed === role)
                  )
                  .map(({ title, href, icon: Icon }) => (
                    <SidebarMenuItem key={href}>
                      <SidebarMenuButton
                        render={
                          <Link
                            href={href}
                            onClick={() => setOpenMobile(false)}
                          />
                        }
                        isActive={pathname === href}
                        title={title}
                        aria-current={pathname === href ? "page" : undefined}
                      >
                        <Icon aria-hidden="true" />
                        <span>{title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="group-data-[collapsible=icon]:items-center">
        <p
          className="truncate px-2 text-sidebar-foreground/70 text-xs group-data-[collapsible=icon]:hidden"
          title={email}
        >
          {email}
        </p>
        <SignOutButton />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

/** Navigation persists across desks; unauthenticated pages remain unchanged. */
export function AppShell({ children }: { children: ReactNode }) {
  const { data: session } = authClient.useSession()
  const pathname = usePathname()
  const trpc = useTRPC()
  const profile = useQuery({
    ...trpc.users.me.queryOptions(),
    enabled: !!session,
    staleTime: 0,
  })
  if (!session) return <>{children}</>

  const section = pageSections[pathname] ?? "Workspace"

  return (
    <SidebarProvider>
      <AppSidebar
        email={session.user.email}
        // The query cache survives account switching; hide previous user's
        // navigation while the new profile is fetched.
        role={
          profile.data?.id === session.user.id ? profile.data.role : undefined
        }
      />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
          <SidebarTrigger />
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-2 text-sm"
          >
            <Link
              href="/"
              className="text-muted-foreground hover:text-foreground"
            >
              AIPMS
            </Link>
            <span aria-hidden="true" className="text-muted-foreground">
              /
            </span>
            <span aria-current="page">{section}</span>
          </nav>
        </header>
        <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
