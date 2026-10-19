"use client"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@workspace/ui/components/sidebar"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { NavLink } from "@/components/sidebar/nav-data"

/**
 * Secondary navigation, pinned to the bottom of the sidebar by the caller.
 * Mirrors the shadcn sidebar-08 "NavSecondary" group.
 */
export function NavSecondary({
  items,
  ...props
}: { items: NavLink[] } & React.ComponentProps<typeof SidebarGroup>) {
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()

  return (
    <SidebarGroup {...props}>
      <SidebarGroupLabel>Governance</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const isActive = pathname === item.href
            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton
                  render={
                    <Link
                      href={item.href}
                      onClick={() => setOpenMobile(false)}
                    />
                  }
                  size="sm"
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
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
