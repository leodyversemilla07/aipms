"use client"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@workspace/ui/components/sidebar"
import { CommandIcon } from "lucide-react"
import Link from "next/link"
import { NavControls } from "@/components/sidebar/nav-controls"
import type { NavItem, NavQueue } from "@/components/sidebar/nav-data"
import { NavDesks } from "@/components/sidebar/nav-desks"
import { NavQueues } from "@/components/sidebar/nav-queues"
import { NavUser } from "@/components/sidebar/nav-user"

/**
 * Inset sidebar with secondary navigation (shadcn block: sidebar-08).
 *
 * Groups, top to bottom: the desks, the work queues that need a decision, and
 * the oversight links pinned to the bottom.
 */
export function AppSidebar({
  user,
  desks,
  queues,
  controls,
}: {
  user: {
    name?: string | null
    email: string
    role?: string
  }
  desks: NavItem[]
  queues: NavQueue[]
  controls: NavItem[]
}) {
  const { setOpenMobile } = useSidebar()

  return (
    <Sidebar variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              render={<Link href="/" onClick={() => setOpenMobile(false)} />}
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <CommandIcon className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">AIPMS</span>
                <span className="truncate text-xs">Supervisory desk</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Desks" className="flex flex-1 flex-col">
          <NavDesks items={desks} />
          <NavQueues items={queues} />
          <NavControls items={controls} className="mt-auto" />
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  )
}
