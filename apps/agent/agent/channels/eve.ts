import { localDev } from "eve/channels/auth"
import { eveChannel } from "eve/channels/eve"
import { operatorAuth } from "../lib/channel-auth"

export default eveChannel({
  // Self-hosted operator access. No anonymous production fallback or implicit
  // trust of Vercel deployments. localDev accepts only actual dev runtimes.
  auth: [operatorAuth(), localDev()],
})
