import type { LucideIcon } from 'lucide-react'
import {
  ArrowLeft,
  Bot,
  Cpu,
  GitBranch,
  LayoutDashboard,
  Server,
  UserCog,
  Users,
} from 'lucide-react'

export type AdminNavItem = {
  title: string
  href: string
  icon: LucideIcon
  exact?: boolean
  external?: boolean
}

export type AdminNavGroup = {
  title: string
  items: AdminNavItem[]
}

export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  {
    title: 'Dashboard',
    items: [{ title: 'Overview', href: '/admin', icon: LayoutDashboard, exact: true }],
  },
  {
    title: 'People',
    items: [
      { title: 'Users', href: '/admin/users', icon: Users },
      { title: 'Admins', href: '/admin/admins', icon: UserCog },
    ],
  },
  {
    title: 'AI & agents',
    items: [
      { title: 'AI usage', href: '/admin/ai', icon: Cpu },
      { title: 'Tools & agents', href: '/admin/agents', icon: Bot },
      { title: 'Agentic flow', href: '/admin/flow', icon: GitBranch },
    ],
  },
  {
    title: 'System',
    items: [{ title: 'Services', href: '/admin/services', icon: Server }],
  },
]

const PAGE_META: Record<string, { title: string; subtitle?: string }> = {
  '/admin': { title: 'Overview', subtitle: 'Deployment health, AI usage, and user metrics' },
  '/admin/users': { title: 'Users', subtitle: 'Accounts, plans, and activity' },
  '/admin/admins': { title: 'Admins', subtitle: 'Operator access control' },
  '/admin/ai': { title: 'AI usage', subtitle: 'Key pool, tokens, and live probes' },
  '/admin/agents': {
    title: 'Tools & agents',
    subtitle: 'REST API docs, agent tools, and health monitoring',
  },
  '/admin/flow': { title: 'Agentic flow', subtitle: 'Pipeline diagram and routing' },
  '/admin/services': { title: 'Services', subtitle: 'Infrastructure probes and integrations' },
}

export function isAdminNavActive(pathname: string, item: AdminNavItem): boolean {
  if (item.external) return false
  if (item.exact) return pathname === item.href
  return pathname === item.href || pathname.startsWith(`${item.href}/`)
}

export function getAdminBreadcrumbs(pathname: string): Array<{ label: string; href?: string }> {
  const crumbs: Array<{ label: string; href?: string }> = [{ label: 'Admin', href: '/admin' }]
  const meta = PAGE_META[pathname]
  if (meta && pathname !== '/admin') {
    crumbs.push({ label: meta.title })
  } else if (pathname !== '/admin') {
    const segment = pathname.split('/').filter(Boolean).pop()
    crumbs.push({ label: segment ? segment.replace(/-/g, ' ') : 'Page' })
  }
  return crumbs
}

export function getAdminPageMeta(pathname: string): { title: string; subtitle?: string } {
  return (
    PAGE_META[pathname] ?? {
      title: pathname.split('/').filter(Boolean).pop()?.replace(/-/g, ' ') ?? 'Admin',
    }
  )
}

export const ADMIN_BACK_TO_APP: AdminNavItem = {
  title: 'Back to app',
  href: '/app',
  icon: ArrowLeft,
  external: true,
}
