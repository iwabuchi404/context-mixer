// Markdown section parsing.
// A section spans from its heading to the next heading of the same or
// higher level. Headings inside code fences are ignored (structured data
// like CSV/JSON is embedded in code blocks by design).

export type Section = {
  slug: string
  title: string
  level: number
  headingLine: number // index of the heading line
  endLine: number     // exclusive end of the section
}

// GitHub-style slug: lowercase, spaces to hyphens, unicode letters kept.
// Japanese titles stay readable; clients URL-encode when calling the API.
const slugify = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[*_`~[\]()!"'#。、．，]/g, '')
    .trim()
    .replace(/\s+/g, '-')
  return slug || 'section'
}

export const parseSections = (content: string): Section[] => {
  const lines = content.split('\n')
  const sections: Section[] = []
  const slugCounts = new Map<string, number>()
  let inFence = false
  let fenceMarker = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fenceMatch = line.match(/^\s*(```+|~~~+)/)
    if (fenceMatch) {
      if (!inFence) {
        inFence = true
        fenceMarker = fenceMatch[1][0]
      } else if (fenceMatch[1][0] === fenceMarker) {
        inFence = false
      }
      continue
    }
    if (inFence) continue

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (!heading) continue

    const title = heading[2]
    const base = slugify(title)
    const count = slugCounts.get(base) ?? 0
    slugCounts.set(base, count + 1)

    sections.push({
      slug: count === 0 ? base : `${base}-${count + 1}`,
      title,
      level: heading[1].length,
      headingLine: i,
      endLine: lines.length, // fixed up below
    })
  }

  // A section ends where the next heading of same-or-higher level starts
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      if (sections[j].level <= sections[i].level) {
        sections[i].endLine = sections[j].headingLine
        break
      }
    }
  }

  return sections
}

export const findSection = (content: string, slug: string): Section | null => {
  return parseSections(content).find((s) => s.slug === slug) ?? null
}

// Full section text including the heading line.
export const extractSection = (content: string, section: Section): string => {
  return content.split('\n').slice(section.headingLine, section.endLine).join('\n')
}

// Replaces the section body (text below the heading). Optionally renames
// the heading, keeping its level. Returns the new document content.
export const replaceSection = (
  content: string,
  section: Section,
  newBody: string,
  newTitle?: string
): string => {
  const lines = content.split('\n')
  const heading = newTitle !== undefined
    ? `${'#'.repeat(section.level)} ${newTitle}`
    : lines[section.headingLine]
  // Normalize spacing: blank line after the heading, and before whatever follows
  const bodyLines = newBody === '' ? [] : ['', ...newBody.split('\n')]
  const rest = lines.slice(section.endLine)
  const replaced = [...lines.slice(0, section.headingLine), heading, ...bodyLines]
  if (rest.length > 0 && replaced[replaced.length - 1].trim() !== '') {
    replaced.push('')
  }
  return [...replaced, ...rest].join('\n')
}
