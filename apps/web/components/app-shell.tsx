"use client"

import { useQuery } from "@tanstack/react-query"
import { authClient } from "@workspace/auth/client"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@workspace/ui/components/breadcrumb"
import { Separator } from "@workspace/ui/components/separator"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@workspace/ui/components/sidebar"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { ReactNode } from "react"
import { AppSidebar } from "@/components/sidebar/app-sidebar"
import {
  controls,
  desks,
  type NavRole,
  queues,
} from "@/components/sidebar/nav-data"
import { useTRPC } from "@/lib/trpc/client"

const pageSections: Record<string, string> = {
  "/": "Dashboard",
  "/intake": "Intake",
  "/procurement": "Procurement",
  "/finance": "Finance",
  "/master-data": "Master data",
  "/approvals": "Approvals",
  "/exceptions": "Invoice exceptions",
  "/agent-runs": "Agent runs",
  "/operations": "Recovery",
  "/audit": "Audit",
  "/sso": "Identity",
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

  const role = (
    profile.data?.id === session.user.id ? profile.data.role : undefined
  ) as NavRole | undefined

  const isAllowed = (itemRoles: readonly NavRole[]) =>
    itemRoles.length === 0 || (role !== undefined && itemRoles.includes(role))

  const section = pageSections[pathname] ?? "Workspace"

  return (
    <SidebarProvider>
      <AppSidebar
        user={{
          name: session.user.name,
          email: session.user.email,
          role,
        }}
        desks={desks.filter((desk) => isAllowed(desk.roles))}
        queues={queues.filter((queue) => isAllowed(queue.roles))}
        controls={controls.filter((entry) => isAllowed(entry.roles))}
      />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex items-center gap-2 px-2 sm:px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <Breadcrumb aria-label="Breadcrumb">
              <BreadcrumbList>
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink render={<Link href="/" />}>
                    AIPMS
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>{section}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>
        {/*
          One content column for every page: the title, its sections and
          their cards share the same edge and the same rhythm.
        */}
        <div className="w-full flex-1 px-4 py-6 sm:px-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}
