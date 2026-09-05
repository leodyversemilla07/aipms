import { defineListTool } from "../lib/list-tool"

export default defineListTool(
  "catalog",
  "List a page of catalog items. Search with q; use page and pageSize for pagination. Monetary fields are integer minor units."
)
