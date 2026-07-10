/**
 * Pure types for the broker credentials store - safe for client components.
 */

import type { BrokerEnv, BrokerId } from '@/lib/brokers/types'

export type BrokerCredentialPayload =
  | {
      brokerId: 'alpaca'
      env: BrokerEnv
      keyId: string
      secret: string
    }
  | {
      brokerId: 'oanda'
      env: BrokerEnv
      token: string
      accountId: string
    }

export type BrokerCredentialMeta = {
  brokerId: BrokerId
  env: BrokerEnv
  connectedAt: string
  lastTestedAt: string | null
  lastTestOk: boolean | null
  /** Last known account currency / equity for fast UI display. */
  account?: {
    currency?: string
    equity?: number
    accountId?: string
  }
}
