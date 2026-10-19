"use client"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@workspace/ui/components/sidebar"
import { ChevronRightIcon } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { NavDesk } from "@/components/sidebar/nav-data"

/**
 * Desk navigation with collapsible in-page sections.
 *
 * Follows the shadcn sidebar-08 block: every desk is a collapsible group and
 * its sections are sub-items. This project runs Base UI rather than Radix, so
 * the block's `asChild` composition becomes the `render` prop.
 */
export function NavMain({ items }: { items: NavDesk[] }) {
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Platform</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const isActive = pathname === item.href
          const sections = item.sections ?? []
          return (
            <Collapsible
              // Re-keying on activation re-mounts the group, so the desk the
              // user just navigated to opens its sections while the others
              // keep whatever the user folded them into.
              key={`${item.href}:${isActive ? "active" : "idle"}`}
              render={<SidebarMenuItem />}
              defaultOpen={isActive}
            >
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
              {sections.length > 0 ? (
                <>
                  <CollapsibleTrigger
                    render={
                      <SidebarMenuAction className="[&>svg]:transition-transform data-[panel-open]:[&>svg]:rotate-90" />
                    }
                  >
                    <ChevronRightIcon />
                    <span className="sr-only">
                      Toggle {item.title} sections
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {sections.map((section) => (
                        <SidebarMenuSubItem key={section.href}>
                          <SidebarMenuSubButton
                            render={
                              <Link
                                href={section.href}
                                onClick={() => setOpenMobile(false)}
                              />
                            }
                          >
                            <span>{section.title}</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </>
              ) : null}
            </Collapsible>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}
