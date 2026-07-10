import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  conversations: defineTable({
    userEmail: v.string(),
    scope: v.string(),
    title: v.optional(v.string()),
    messages: v.array(v.any()),
    updatedAt: v.string(),
  }).index('by_user_scope', ['userEmail', 'scope'])
    .index('by_user', ['userEmail']),
})
