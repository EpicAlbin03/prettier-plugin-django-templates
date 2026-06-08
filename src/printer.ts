// @ts-nocheck

import { ORIGINAL_SOURCE } from './parser.js'
import { printAliasExpression } from './print/AliasExpression.js'
import { printArrayExpression } from './print/ArrayExpression.js'
import { printAttribute } from './print/Attribute.js'
import { printAutoescapeBlock } from './print/AutoescapeBlock.js'
import { printBinaryExpression } from './print/BinaryExpression.js'
import { printBlockStatement } from './print/BlockStatement.js'
import { printCallExpression } from './print/CallExpression.js'
import { printConditionalExpression } from './print/ConditionalExpression.js'
import { printDeclaration } from './print/Declaration.js'
import { printElement } from './print/Element.js'
import { printExpressionStatement } from './print/ExpressionStatement.js'
import { printExtendsStatement } from './print/ExtendsStatement.js'
import { printFilterBlockStatement } from './print/FilterBlockStatement.js'
import { printFilterExpression } from './print/FilterExpression.js'
import { printForStatement } from './print/ForStatement.js'
import { printGenericToken } from './print/GenericToken.js'
import { printGenericTwigTag } from './print/GenericTwigTag.js'
import { printHtmlComment } from './print/HtmlComment.js'
import { printIdentifier } from './print/Identifier.js'
import { printIfStatement } from './print/IfStatement.js'
import { printIncludeStatement } from './print/IncludeStatement.js'
import { printMemberExpression } from './print/MemberExpression.js'
import { printNamedArgumentExpression } from './print/NamedArgumentExpression.js'
import { printObjectExpression } from './print/ObjectExpression.js'
import { printObjectProperty } from './print/ObjectProperty.js'
import { printSequenceExpression } from './print/SequenceExpression.js'
import { printSliceExpression } from './print/SliceExpression.js'
import { printSpacelessBlock } from './print/SpacelessBlock.js'
import { printStringLiteral } from './print/StringLiteral.js'
import { printTestExpression } from './print/TestExpression.js'
import { printTextStatement } from './print/TextStatement.js'
import { printTwigComment } from './print/TwigComment.js'
import { printUnaryExpression } from './print/UnaryExpression.js'
import { printUnarySubclass } from './print/UnarySubclass.js'
import { printUrlStatement } from './print/UrlStatement.js'
import { printWithStatement } from './print/WithStatement.js'
import { isHtmlCommentEqualTo, isTwigCommentEqualTo, isWhitespaceNode } from './util'

const printFunctions = {}

const isHtmlIgnoreNextComment = isHtmlCommentEqualTo('prettier-ignore')
const isHtmlIgnoreStartComment = isHtmlCommentEqualTo('prettier-ignore-start')
const isHtmlIgnoreEndComment = isHtmlCommentEqualTo('prettier-ignore-end')
const isTemplateIgnoreNextComment = isTwigCommentEqualTo('prettier-ignore')
const isTemplateIgnoreStartComment = isTwigCommentEqualTo('prettier-ignore-start')
const isTemplateIgnoreEndComment = isTwigCommentEqualTo('prettier-ignore-end')

const isIgnoreNextComment = (value) => isHtmlIgnoreNextComment(value) || isTemplateIgnoreNextComment(value)
const isIgnoreRegionStartComment = (value) => isHtmlIgnoreStartComment(value) || isTemplateIgnoreStartComment(value)
const isIgnoreRegionEndComment = (value) => isHtmlIgnoreEndComment(value) || isTemplateIgnoreEndComment(value)

let originalSource = ''
let ignoreRegion = false
let ignoreNext = false

const shouldApplyIgnoreNext = (node) => !isWhitespaceNode(node)

const checkForIgnoreStart = (node) => {
  ignoreNext = (ignoreNext && !shouldApplyIgnoreNext(node)) || isIgnoreNextComment(node)
  ignoreRegion = ignoreRegion || isIgnoreRegionStartComment(node)
}

const checkForIgnoreEnd = (node) => {
  if (ignoreRegion && isIgnoreRegionEndComment(node)) {
    ignoreRegion = false
  }
}

const canGetSubstringForNode = (node) =>
  Boolean(
    originalSource &&
      node.loc &&
      node.loc.start &&
      node.loc.end &&
      node.loc.start.index !== undefined &&
      node.loc.end.index !== undefined
  )

const getSubstringForNode = (node) => originalSource.slice(node.loc.start.index, node.loc.end.index)

const print = (path, options, printChild) => {
  const node = path.getValue()
  const nodeType = node.constructor.name

  if (node[ORIGINAL_SOURCE]) {
    originalSource = node[ORIGINAL_SOURCE]
  }

  if (options.djangoPrintWidth) {
    options.printWidth = options.djangoPrintWidth
  }

  checkForIgnoreEnd(node)
  const useOriginalSource = (shouldApplyIgnoreNext(node) && ignoreNext) || ignoreRegion
  const hasPrintFunction = printFunctions[nodeType]

  if (!useOriginalSource && hasPrintFunction) {
    checkForIgnoreStart(node)
    return printFunctions[nodeType](node, path, printChild, options)
  }

  if (!hasPrintFunction) {
    console.warn(`No print function available for node type "${nodeType}"`)
  }

  checkForIgnoreStart(node)

  if (canGetSubstringForNode(node)) {
    return getSubstringForNode(node)
  }

  return ''
}

const returnNodeValue = (node) => `${node.value}`

printFunctions.SequenceExpression = printSequenceExpression
printFunctions.ConstantValue = (node) => node.value
printFunctions.StringLiteral = printStringLiteral
printFunctions.Identifier = printIdentifier
printFunctions.UnaryExpression = printUnaryExpression
printFunctions.BinaryExpression = printBinaryExpression
printFunctions.BinarySubclass = printBinaryExpression
printFunctions.UnarySubclass = printUnarySubclass
printFunctions.TestExpression = printTestExpression
printFunctions.ConditionalExpression = printConditionalExpression
printFunctions.Element = printElement
printFunctions.Attribute = printAttribute
printFunctions.PrintTextStatement = printTextStatement
printFunctions.PrintExpressionStatement = printExpressionStatement
printFunctions.MemberExpression = printMemberExpression
printFunctions.FilterExpression = printFilterExpression
printFunctions.ObjectExpression = printObjectExpression
printFunctions.ObjectProperty = printObjectProperty
printFunctions.Fragment = (_node, path, printChild) => path.call(printChild, 'value')
printFunctions.NumericLiteral = returnNodeValue
printFunctions.BooleanLiteral = returnNodeValue
printFunctions.NullLiteral = () => 'null'
printFunctions.ArrayExpression = printArrayExpression
printFunctions.CallExpression = printCallExpression
printFunctions.NamedArgumentExpression = printNamedArgumentExpression
printFunctions.SliceExpression = printSliceExpression
printFunctions.AliasExpression = printAliasExpression
printFunctions.BlockStatement = printBlockStatement
printFunctions.SpacelessBlock = printSpacelessBlock
printFunctions.AutoescapeBlock = printAutoescapeBlock
printFunctions.IncludeStatement = printIncludeStatement
printFunctions.UrlStatement = printUrlStatement
printFunctions.WithStatement = printWithStatement
printFunctions.IfStatement = printIfStatement
printFunctions.ForStatement = printForStatement
printFunctions.BinaryConcatExpression = printBinaryExpression
printFunctions.ExtendsStatement = printExtendsStatement
printFunctions.FilterBlockStatement = printFilterBlockStatement
printFunctions.TwigComment = printTwigComment
printFunctions.HtmlComment = printHtmlComment
printFunctions.Declaration = printDeclaration
printFunctions.GenericTwigTag = (node, path, printChild, options) => printGenericTwigTag(node, path, printChild, options)
printFunctions.GenericToken = printGenericToken
printFunctions.String = (value) => value

export { print }
