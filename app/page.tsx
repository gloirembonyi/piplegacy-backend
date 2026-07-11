import { redirect } from 'next/navigation'

/** This is an API-only backend with no web UI - point visitors at the interactive docs
 * instead of 404ing on "/" (see app/api-docs/page.tsx and app/api/openapi.json). */
export default function RootPage() {
  redirect('/api-docs')
}
