import { clearUserSessionClientData } from '@/lib/user-client-cache'

/** End session server-side and hard-navigate so in-memory React state resets. */
export async function clientLogout(): Promise<void> {
  clearUserSessionClientData()
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    })
  } catch {
    /* still redirect */
  }
  window.location.href = '/login'
}
