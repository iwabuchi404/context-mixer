// Server-side markdown rendering for the Web UI.
// Security: this renders content written by AI agents and external services
// (inbox), so raw HTML in markdown is escaped, never passed through.
import { Marked } from 'marked'
import { slugify } from './sections'

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const SAFE_PROTOCOLS = /^(https?:|mailto:|\/)/i

// Resolves [[doc_xxx]] / [[doc_xxx|label]] into markdown links before
// rendering. Fence-aware: notation inside code blocks stays literal.
const resolveDocLinks = (content: string, titles: Map<string, string>): string => {
  const lines = content.split('\n')
  let inFence = false
  let fenceMarker = ''

  return lines.map((line) => {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/)
    if (fenceMatch) {
      if (!inFence) {
        inFence = true
        fenceMarker = fenceMatch[1][0]
      } else if (fenceMatch[1][0] === fenceMarker) {
        inFence = false
      }
      return line
    }
    if (inFence) return line

    return line.replace(/\[\[(doc_[a-zA-Z0-9_-]+)(?:\|([^\]]*))?\]\]/g, (_, id, label) => {
      const title = label || titles.get(id) || id
      return `[${title}](/?doc=${id})`
    })
  }).join('\n')
}

// Renders markdown to HTML with heading ids matching parseSections() slugs.
export const renderMarkdown = (content: string, linkTitles?: Map<string, string>): string => {
  const slugCounts = new Map<string, number>()

  const marked = new Marked({
    renderer: {
      html(html: string) {
        return escapeHtml(html)
      },
      heading(text: string, level: number, raw: string) {
        const base = slugify(raw)
        const count = slugCounts.get(base) ?? 0
        slugCounts.set(base, count + 1)
        const slug = count === 0 ? base : `${base}-${count + 1}`
        return `<h${level} id="${escapeHtml(slug)}">${text}</h${level}>\n`
      },
      link(href: string, title: string | null | undefined, text: string) {
        const safeHref = SAFE_PROTOCOLS.test(href) ? href : '#'
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
        return `<a href="${escapeHtml(safeHref)}"${titleAttr}>${text}</a>`
      },
      image(href: string, title: string | null | undefined, text: string) {
        const safeHref = SAFE_PROTOCOLS.test(href) ? href : ''
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
        return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}"${titleAttr}>`
      },
      table(header: string, body: string) {
        return `<div class="table-wrap"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>\n`
      },
    },
  })

  const source = linkTitles ? resolveDocLinks(content, linkTitles) : content
  return marked.parse(source, { async: false }) as string
}
