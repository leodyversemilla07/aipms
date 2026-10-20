import type { LucideIcon } from "lucide-react"
import {
  BotIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  DatabaseIcon,
  FileClockIcon,
  InboxIcon,
  LayoutDashboardIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  WalletIcon,
} from "lucide-react"

/**
 * Navigation model for the inset sidebar (shadcn block: sidebar-08).
 *
 * Three groups, one rule each:
 * - `desks`    places with content of their own, in workflow order
 * - `queues`   lists of items waiting on a person
 * - `controls` oversight and instance configuration
 *
 * Every entry is a page: a navigation link never points at a fragment of
 * another page.
 */

/** Roles that may see a navigation entry. Empty means every signed-in user. */
export type NavRole = "admin" | "finance" | "procurement" | "user"

export interface NavItem {
  title: string
  href: string
  icon: LucideIcon
  roles: NavRole[]
}

export interface NavQueue extends NavItem {}

export const desks: NavItem[] = [
  {
    title: "Dashboard",
    href: "/",
    icon: LayoutDashboardIcon,
    roles: [],
  },
  {
    title: "Intake",
    href: "/intake",
    icon: InboxIcon,
    roles: ["finance", "admin"],
  },
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
    title: "Master data",
    href: "/master-data",
    icon: DatabaseIcon,
    roles: ["procurement", "finance", "admin"],
  },
]

export const queues: NavQueue[] = [
  {
    title: "Approvals",
    href: "/approvals",
    icon: ClipboardCheckIcon,
    roles: ["procurement", "finance", "admin"],
  },
  {
    title: "Invoice exceptions",
    href: "/exceptions",
    icon: TriangleAlertIcon,
    roles: ["finance", "admin"],
  },
  {
    title: "Agent runs",
    href: "/agent-runs",
    icon: BotIcon,
    roles: ["finance", "admin"],
  },
  {
    title: "Delivery recovery",
    href: "/operations",
    icon: RotateCcwIcon,
    roles: ["finance", "admin"],
  },
]

export const controls: NavItem[] = [
  {
    title: "Audit trail",
    href: "/audit",
    icon: FileClockIcon,
    roles: ["finance", "admin"],
  },
  {
    title: "Identity & SSO",
    href: "/sso",
    icon: ShieldCheckIcon,
    roles: ["admin"],
  },
]
