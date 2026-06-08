// @ts-nocheck
import { EXPRESSION_NEEDED, STRING_NEEDS_QUOTES, wrapExpressionIfNeeded } from '../util'
import { concat, group } from './../util/prettier-doc-builders.js'

export const printMemberExpression = (node, path, print) => {
  node[EXPRESSION_NEEDED] = false
  node[STRING_NEEDS_QUOTES] = true
  const parts = [path.call(print, 'object')]
  const squareBrackets = false
  if (!squareBrackets) {
    node[STRING_NEEDS_QUOTES] = false
  }
  parts.push(squareBrackets ? '[' : '.')
  parts.push(path.call(print, 'property'))
  if (squareBrackets) {
    parts.push(']')
  }
  wrapExpressionIfNeeded(path, parts, node)
  return group(concat(parts))
}
