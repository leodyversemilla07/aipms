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
 * Three groups, mirroring the block's structure:
 * - `desks`     the supervisory desks, each with collapsible in-page sections
 * - `queues`    cross-desk work queues that need a human decision
 * - `governance` audit, recovery and identity, pinned to the bottom
 */

/** Roles that may see a navigation entry. Empty means every signed-in user. */
export type NavRole = "admin" | "finance" | "procurement" | "user"

export interface NavSection {
  title: string
  /** Deep link into the desk page, e.g. /procurement#purchase-orders */
  href: string
}

export interface NavDesk {
  title: string
  href: string
  icon: LucideIcon
  roles: NavRole[]
  /** In-page sections of the desk; rendered as collapsible sub-navigation. */
  sections?: NavSection[]
}

export interface NavQueue {
  title: string
  href: string
  icon: LucideIcon
  roles: NavRole[]
  /** Desk that owns the queue, used by the row action menu. */
  deskTitle: string
  deskHref: string
}

export interface NavLink {
  title: string
  href: string
  icon: LucideIcon
  roles: NavRole[]
}

export const desks: NavDesk[] = [
  {
    title: "Overview",
    href: "/",
    icon: LayoutDashboardIcon,
    roles: [],
  },
  {
    title: "Procurement",
    href: "/procurement",
    icon: ClipboardListIcon,
    roles: ["procurement", "finance", "admin"],
    sections: [
      { title: "Sourcing", href: "/procurement#sourcing" },
      { title: "Issue PO", href: "/procurement#issue-po" },
      { title: "Purchase orders", href: "/procurement#purchase-orders" },
      { title: "Goods receipts", href: "/procurement#goods-receipts" },
      { title: "Vendor messages", href: "/procurement#vendor-messages" },
    ],
  },
  {
    title: "Finance",
    href: "/finance",
    icon: WalletIcon,
    roles: ["finance", "admin"],
    sections: [
      { title: "Register invoice", href: "/finance#register-invoice" },
      { title: "Invoices", href: "/finance#invoices" },
      { title: "Payment runs", href: "/finance#payment-runs" },
      { title: "ERP sync", href: "/finance#erp-sync" },
      { title: "BIR withholding", href: "/finance#bir-withholding" },
    ],
  },
  {
    title: "Intake",
    href: "/intake",
    icon: InboxIcon,
    roles: ["finance", "admin"],
    sections: [
      { title: "Ingest document", href: "/intake#ingest-document" },
      { title: "Queue", href: "/intake#queue" },
    ],
  },
  {
    title: "Master data",
    href: "/master-data",
    icon: DatabaseIcon,
    roles: ["procurement", "finance", "admin"],
    sections: [
      { title: "Vendors", href: "/master-data#vendors" },
      { title: "Catalog items", href: "/master-data#catalog-items" },
      { title: "Budgets", href: "/master-data#budgets" },
      { title: "Policies", href: "/master-data#policies" },
    ],
  },
]

export const queues: NavQueue[] = [
  {
    title: "Approvals",
    href: "/#exception-queue",
    icon: ClipboardCheckIcon,
    roles: ["procurement", "finance", "admin"],
    deskTitle: "Overview",
    deskHref: "/",
  },
  {
    title: "Invoice exceptions",
    href: "/finance#invoices",
    icon: TriangleAlertIcon,
    roles: ["finance", "admin"],
    deskTitle: "Finance",
    deskHref: "/finance",
  },
  {
    title: "Agent runs",
    href: "/#agent-activity",
    icon: BotIcon,
    roles: ["finance", "admin"],
    deskTitle: "Overview",
    deskHref: "/",
  },
]

export const governance: NavLink[] = [
  {
    title: "Audit trail",
    href: "/audit",
    icon: FileClockIcon,
    roles: ["finance", "admin"],
  },
  {
    title: "Recovery",
    href: "/operations",
    icon: RotateCcwIcon,
    roles: ["finance", "admin"],
  },
  {
    title: "Identity & SSO",
    href: "/sso",
    icon: ShieldCheckIcon,
    roles: ["admin"],
  },
]
