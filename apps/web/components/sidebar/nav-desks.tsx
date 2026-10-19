"use client"

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@workspace/ui/components/sidebar"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { NavItem } from "@/components/sidebar/nav-data"

/**
 * The desks: places with content of their own, in workflow order.
 *
 * The shadcn sidebar-08 block renders this group as "NavMain" with collapsible
 * sub-sections; the desk pages here carry their own section headings, so the
 * rail stays a flat list instead of duplicating every panel title.
 */
export function NavDesks({ items }: { items: NavItem[] }) {
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Desks</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const isActive = pathname === item.href
          return (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton
                render={
                  <Link href={item.href} onClick={() => setOpenMobile(false)} />
                }
                isActive={isActive}
                tooltip={item.title}
                aria-current={isActive ? "page" : undefined}
              >
                <item.icon aria-hidden="true" />
                <span>{item.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}
