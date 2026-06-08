// @ts-nocheck

import { doc } from 'prettier'

export const {
  addAlignmentToDoc,
  align,
  breakParent,
  concat,
  conditionalGroup,
  cursor,
  dedent,
  dedentToRoot,
  fill,
  group,
  hardline,
  hardlineWithoutBreakParent,
  ifBreak,
  indent,
  indentIfBreak,
  join,
  label,
  line,
  lineSuffix,
  lineSuffixBoundary,
  literalline,
  literallineWithoutBreakParent,
  markAsRoot,
  softline,
  trim
} = doc.builders
