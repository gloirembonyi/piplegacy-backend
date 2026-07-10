import { mutation, query } from './_generated/server'
import { v } from 'convex/values'

const MAX_MESSAGES = 40

export const get = query({
  args: {
    userEmail: v.string(),
    scope: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('conversations')
      .withIndex('by_user_scope', (q) =>
        q.eq('userEmail', args.userEmail.toLowerCase()).eq('scope', args.scope)
      )
      .unique()
    if (!row) return null
    return {
      title: row.title,
      messages: row.messages,
      updatedAt: row.updatedAt,
    }
  },
})

export const save = mutation({
  args: {
    userEmail: v.string(),
    scope: v.string(),
    title: v.optional(v.string()),
    messages: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    const userEmail = args.userEmail.toLowerCase()
    const updatedAt = new Date().toISOString()
    const messages = args.messages.slice(-MAX_MESSAGES)
    const existing = await ctx.db
      .query('conversations')
      .withIndex('by_user_scope', (q) =>
        q.eq('userEmail', userEmail).eq('scope', args.scope)
      )
      .unique()

    if (existing) {
      await ctx.db.patch(existing._id, {
        title: args.title?.slice(0, 80),
        messages,
        updatedAt,
      })
    } else {
      await ctx.db.insert('conversations', {
        userEmail,
        scope: args.scope,
        title: args.title?.slice(0, 80),
        messages,
        updatedAt,
      })
    }

    return { title: args.title, messages, updatedAt }
  },
})

export const clear = mutation({
  args: {
    userEmail: v.string(),
    scope: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('conversations')
      .withIndex('by_user_scope', (q) =>
        q.eq('userEmail', args.userEmail.toLowerCase()).eq('scope', args.scope)
      )
      .unique()
    if (row) await ctx.db.delete(row._id)
  },
})

export const listForUser = query({
  args: {
    userEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const userEmail = args.userEmail.toLowerCase()
    const rows = await ctx.db
      .query('conversations')
      .withIndex('by_user', (q) => q.eq('userEmail', userEmail))
      .collect()
    return rows
      .map((row) => ({
        scope: row.scope,
        title: row.title,
        messages: row.messages,
        updatedAt: row.updatedAt,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  },
})
