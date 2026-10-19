"use client"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@workspace/ui/components/sidebar"
import { CommandIcon } from "lucide-react"
import Link from "next/link"
import type { NavDesk, NavLink, NavQueue } from "@/components/sidebar/nav-data"
import { NavMain } from "@/components/sidebar/nav-main"
import { NavProjects } from "@/components/sidebar/nav-projects"
import { NavSecondary } from "@/components/sidebar/nav-secondary"
import { NavUser } from "@/components/sidebar/nav-user"
import { SignOutButton } from "@/components/sign-out-button"

/**
 * Inset sidebar with secondary navigation (shadcn block: sidebar-08).
 *
 * Groups, top to bottom: the desks with their collapsible sections, the work
 * queues that need a decision, and the governance links pinned to the bottom.
 */
export function AppSidebar({
  user,
  desks,
  queues,
  governance,
}: {
  user: {
    name?: string | null
    email: string
    role?: string
  }
  desks: NavDesk[]
  queues: NavQueue[]
  governance: NavLink[]
}) {
  const { setOpenMobile } = useSidebar()

  return (
    <Sidebar variant="inset" collapsible="icon" aria-label="Desks">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              render={<Link href="/" onClick={() => setOpenMobile(false)} />}
              title="AIPMS overview"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <CommandIcon className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">AIPMS</span>
                <span className="truncate text-sidebar-foreground/70 text-xs">
                  Supervisory desk
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Desks" className="flex flex-1 flex-col">
          <NavMain items={desks} />
          <NavProjects items={queues} />
          <NavSecondary items={governance} className="mt-auto" />
        </nav>
      </SidebarContent>
      <SidebarFooter className="group-data-[collapsible=icon]:items-center">
        <NavUser user={user} />
        <SignOutButton />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
