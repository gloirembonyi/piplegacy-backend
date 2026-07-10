/**
 * Normalize agent reply markdown before render / persist.
 */

import { formatAgentReplyText } from '@/lib/agent/format-reply-agent'

export function normalizeAgentReply(text: string): string {
  return formatAgentReplyText(text)
}
