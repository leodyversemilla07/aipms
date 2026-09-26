"use client"

import { authClient } from "@workspace/auth/client"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"
import { BudgetsPanel } from "@/components/master-data/budgets"
import { CatalogPanel } from "@/components/master-data/catalog"
import { PoliciesPanel } from "@/components/master-data/policies"
import { VendorsPanel } from "@/components/master-data/vendors"
import { PageHeader } from "@/components/page-header"
import { SignInCard } from "@/components/sign-in"

function MasterDataBody() {
  return (
    <div className="flex w-full flex-col gap-8">
      <PageHeader
        title="Master data"
        description="Vendors, catalog, budgets & policies"
      />
      {/* Tabs for Master‑Data panels */}
      <Tabs defaultValue="vendors" className="w-full">
        <TabsList variant="default" className="mb-4">
          <TabsTrigger value="vendors">Vendors</TabsTrigger>
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
          <TabsTrigger value="budgets">Budgets</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
        </TabsList>
        <TabsContent value="vendors">
          <VendorsPanel />
        </TabsContent>
        <TabsContent value="catalog">
          <CatalogPanel />
        </TabsContent>
        <TabsContent value="budgets">
          <BudgetsPanel />
        </TabsContent>
        <TabsContent value="policies">
          <PoliciesPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export function MasterDataDesk() {
  const { data: session, isPending } = authClient.useSession()

  if (isPending) {
    return (
      <p className="py-24 text-center text-muted-foreground text-sm">
        Checking session…
      </p>
    )
  }
  if (!session) {
    return (
      <main className="flex min-h-svh items-center justify-center p-4">
        <SignInCard />
      </main>
    )
  }
  return <MasterDataBody />
}
