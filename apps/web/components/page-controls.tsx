"use client"

import { Button } from "@workspace/ui/components/button"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
} from "@workspace/ui/components/pagination"
import { Fragment } from "react"

/** Shared shadcn page-number controls for server-paginated desks. */
export function PageControls({
  page,
  totalPages,
  onPageChange,
}: {
  page: number
  totalPages: number
  onPageChange: (page: number) => void
}) {
  const pages = [...new Set([1, page - 1, page, page + 1, totalPages])]
    .filter((value) => value >= 1 && value <= totalPages)
    .sort((a, b) => a - b)

  return (
    <Pagination className="mx-0 w-auto justify-start">
      <PaginationContent>
        <PaginationItem>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page === 1}
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </Button>
        </PaginationItem>
        {pages.map((number, index) => (
          <Fragment key={number}>
            {index > 0 && number - (pages[index - 1] ?? 0) > 1 ? (
              <PaginationItem>
                <PaginationEllipsis />
              </PaginationItem>
            ) : null}
            <PaginationItem>
              <Button
                type="button"
                variant={number === page ? "outline" : "ghost"}
                size="icon-sm"
                aria-label={`Go to page ${number}`}
                aria-current={number === page ? "page" : undefined}
                onClick={() => onPageChange(number)}
              >
                {number}
              </Button>
            </PaginationItem>
          </Fragment>
        ))}
        <PaginationItem>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page === totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </Button>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  )
}
