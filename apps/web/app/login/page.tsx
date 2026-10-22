import { SignInCard } from "@/components/sign-in"

/**
 * The dedicated sign-in page, following the shadcn `login-01` block.
 *
 * The way-in view - pending check, form, hand over - lives in `SignInCard`, and
 * the desks render the same view when there is no session. This route simply
 * gives the way in a URL of its own (for a bookmark, an email link, or an SSO
 * return).
 */
export default function Page() {
  return <SignInCard />
}
