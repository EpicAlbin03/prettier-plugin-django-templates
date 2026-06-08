// @ts-nocheck
import { Element } from 'melody-types'
import { printOpeningTag } from './print/Element'
import { concat, group, hardline, indent, softline } from './util/prettier-doc-builders'

export function embed(path, options) {
  const node = path.getValue()
  if (options.embeddedLanguageFormatting !== 'auto' || !(node instanceof Element)) {
    return null
  }

  const tagName = node.name.toLowerCase()
  if (tagName !== 'script' && tagName !== 'style') {
    return null
  }

  const child = node.children?.[0]
  const value = child?.value?.value
  if (!value) {
    return null
  }

  return async (textToDoc, print, path, options) => {
    const parser = tagName === 'script' ? 'babel' : 'css'
    const opening = group(printOpeningTag(node, path, print))
    const children = indent([softline, await textToDoc(value, { ...options, parser })])
    return [opening, children, hardline, concat(['</', node.name, '>'])]
  }
}
