"use client"

import { useQueryClient } from "@tanstack/react-query"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@workspace/ui/components/sidebar"
import {
  ArrowRightIcon,
  LayoutDashboardIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
} from "lucide-react"
import Link from "next/link"
import type { NavQueue } from "@/components/sidebar/nav-data"

/**
 * Work queues that need a human decision, with a per-row action menu.
 *
 * Mirrors the shadcn sidebar-08 "Projects" group: a list of items where the
 * trailing affordance opens a small menu of related actions.
 */
export function NavProjects({ items }: { items: NavQueue[] }) {
  const { isMobile } = useSidebar()
  const queryClient = useQueryClient()

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>Queues</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.href}>
            <SidebarMenuButton
              render={<Link href={item.href} />}
              tooltip={item.title}
            >
              <item.icon aria-hidden="true" />
              <span>{item.title}</span>
            </SidebarMenuButton>
            <DropdownMenu>
              <DropdownMenuTrigger render={<SidebarMenuAction showOnHover />}>
                <MoreHorizontalIcon />
                <span className="sr-only">More actions for {item.title}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-48"
                side={isMobile ? "bottom" : "right"}
                align={isMobile ? "end" : "start"}
              >
                <DropdownMenuGroup>
                  <DropdownMenuItem render={<Link href={item.href} />}>
                    <ArrowRightIcon />
                    Open queue
                  </DropdownMenuItem>
                  <DropdownMenuItem render={<Link href={item.deskHref} />}>
                    <LayoutDashboardIcon />
                    Open {item.deskTitle}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    onClick={() => {
                      void queryClient.invalidateQueries()
                    }}
                  >
                    <RefreshCwIcon />
                    Refresh data
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
