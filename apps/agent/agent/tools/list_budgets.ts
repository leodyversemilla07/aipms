import { defineListTool } from "../lib/list-tool"

export default defineListTool(
  "budget",
  "List a page of budgets. q searches name, cost center or period (not an exact filter). Use page and pageSize for pagination. limitMinor, spentMinor and committedMinor are integer minor units."
)
