"use client"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@workspace/ui/components/sidebar"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { NavItem } from "@/components/sidebar/nav-data"

/**
 * Oversight and instance configuration, pinned to the bottom of the rail.
 * The shadcn sidebar-08 block renders this group as "NavSecondary".
 */
export function NavControls({
  items,
  ...props
}: { items: NavItem[] } & React.ComponentProps<typeof SidebarGroup>) {
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()

  return (
    <SidebarGroup {...props}>
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
