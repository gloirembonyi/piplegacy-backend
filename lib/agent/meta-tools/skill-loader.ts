/**
 * Load SKILL.md files into agent context (claw-code-parity Skill tool).
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const SKILL_ROOTS = [
  path.join(process.cwd(), '.cursor', 'skills'),
  path.join(process.cwd(), '.cursor', 'skills-cursor'),
  path.join(process.cwd(), 'skills'),
]

function parseDescription(markdown: string): string {
  const lines = markdown.split('\n')
  for (const line of lines) {
    const t = line.trim()
    if (t && !t.startsWith('#')) return t.slice(0, 240)
  }
  return 'Skill instructions loaded.'
}

async function findSkillFile(skillName: string): Promise<string | null> {
  const normalized = skillName.trim().replace(/^\/+/, '').replace(/\.md$/i, '')
  if (!normalized) return null

  for (const root of SKILL_ROOTS) {
    const direct = path.join(root, normalized, 'SKILL.md')
    try {
      await fs.access(direct)
      return direct
    } catch {
      /* try dir scan */
    }

    try {
      const entries = await fs.readdir(root, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.toLowerCase().includes(normalized.toLowerCase())) {
          const candidate = path.join(root, entry.name, 'SKILL.md')
          try {
            await fs.access(candidate)
            return candidate
          } catch {
            continue
          }
        }
      }
    } catch {
      continue
    }
  }

  return null
}

export async function loadAgentSkill(skill: string): Promise<{
  skill: string
  path: string
  description: string
  prompt: string
}> {
  const file = await findSkillFile(skill)
  if (!file) {
    throw new Error(`Skill not found: ${skill}. Check .cursor/skills/`)
  }

  const prompt = await fs.readFile(file, 'utf-8')
  return {
    skill,
    path: file,
    description: parseDescription(prompt),
    prompt: prompt.slice(0, 12_000),
  }
}

export async function listAvailableSkills(): Promise<Array<{ name: string; path: string }>> {
  const out: Array<{ name: string; path: string }> = []

  for (const root of SKILL_ROOTS) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillFile = path.join(root, entry.name, 'SKILL.md')
        try {
          await fs.access(skillFile)
          out.push({ name: entry.name, path: skillFile })
        } catch {
          continue
        }
      }
    } catch {
      continue
    }
  }

  return out
}
