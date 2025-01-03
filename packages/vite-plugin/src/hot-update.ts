import type {
  HMRCompFnsName,
  VineCompilerCtx,
  VineCompilerHooks,
  VineFileCtx,
} from '@vue-vine/compiler'
import type { HmrContext, ModuleNode } from 'vite'
import {
  createVineFileCtx,
  doAnalyzeVine,
  doValidateVine,
  findVineCompFnDecls,
} from '@vue-vine/compiler'
import { QUERY_TYPE_SCRIPT, QUERY_TYPE_STYLE } from './constants'
import { parseQuery } from './parse-query'
import { areStrArraysEqual, normalizeLineEndings } from './utils'

// HMR Strategy:
// 1. Only update style if just style changed
// 2. Only re-render current component if just template changed
// 3. Any other condition will re-render the whole module
// 4. If v-bind changes will re-render the whole module

function reAnalyzeVine(
  code: string,
  fileId: string,
  compilerHooks: VineCompilerHooks,
) {
  const vineFileCtx: VineFileCtx = createVineFileCtx(code, fileId, { compilerHooks })
  compilerHooks.onBindFileCtx?.(fileId, vineFileCtx)
  const vineCompFnDecls = findVineCompFnDecls(vineFileCtx.root)
  doValidateVine(compilerHooks, vineFileCtx, vineCompFnDecls)
  doAnalyzeVine(compilerHooks, vineFileCtx, vineCompFnDecls)
  compilerHooks.onEnd?.()
  return vineFileCtx
}

interface PatchModuleRes {
  hmrCompFnsName: HMRCompFnsName
  type: null | 'style' | 'module'
  scopeId?: string
}
function patchModule(
  oldVFCtx: VineFileCtx,
  newVFCtx: VineFileCtx,
) {
  let patchRes: PatchModuleRes = {
    hmrCompFnsName: null,
    type: null,
  }
  const nVineCompFns = newVFCtx.vineCompFns
  const oVineCompFns = oldVFCtx.vineCompFns
  if (oVineCompFns.length !== nVineCompFns.length) {
    newVFCtx.renderOnly = false
    return patchRes
  }

  const nStyleDefine = newVFCtx.styleDefine
  const oStyleDefine = oldVFCtx.styleDefine
  const nOriginCode = normalizeLineEndings(newVFCtx.originCode)
  const oOriginCode = normalizeLineEndings(oldVFCtx.originCode)
  for (let i = 0; i < nVineCompFns.length; i++) {
    const nCompFns = nVineCompFns[i]
    const oCompFns = oVineCompFns[i]
    if (
      (!oCompFns || !nCompFns)
      || (!oCompFns.fnItselfNode || !nCompFns.fnItselfNode)
    ) {
      continue
    }

    const nCompFnsTemplate = normalizeLineEndings(nCompFns.templateSource)
    const oCompFnsTemplate = normalizeLineEndings(oCompFns.templateSource)
    const nCompFnsStyles = nStyleDefine[nCompFns.scopeId]?.map(style => style.source ?? '')
    const oCompFnsStyles = oStyleDefine[oCompFns.scopeId]?.map(style => style.source ?? '')
    // 1. Get component function AST Node range for its code content
    const nCompFnCode = nOriginCode.substring(Number(nCompFns.fnItselfNode.start), Number((nCompFns.fnItselfNode!.end)))
    const oCompFnCode = oOriginCode.substring(Number(oCompFns.fnItselfNode.start), Number((oCompFns.fnItselfNode!.end)))
    // 2. Clean template content
    const nCompFnCodeNonTemplate = nCompFnCode.replace(nCompFnsTemplate, '')
    const oCompFnCodeNonTemplate = oCompFnCode.replace(oCompFnsTemplate, '')
    // 3. Clean style content
    let nCompFnCodePure = nCompFnCodeNonTemplate
    nCompFnsStyles?.forEach((style) => {
      nCompFnCodePure = nCompFnCodePure.replace(style, '')
    })
    let oCompFnCodePure = oCompFnCodeNonTemplate
    oCompFnsStyles?.forEach((style) => {
      oCompFnCodePure = oCompFnCodePure.replace(style, '')
    })

    // Compare with the remaining characters without style and template interference
    // 4. If not equal, it means that the script has changed
    if (nCompFnCodePure !== oCompFnCodePure) {
      patchRes.hmrCompFnsName = nCompFns.fnName
      newVFCtx.renderOnly = false
    }
    else if (nCompFnsTemplate !== oCompFnsTemplate) {
      // script equal, then compare template
      patchRes.hmrCompFnsName = nCompFns.fnName
      newVFCtx.renderOnly = true
    }
    else if (!areStrArraysEqual(nCompFnsStyles, oCompFnsStyles)) {
      // script and template equal, then compare style
      const oCssBindingsVariables = Object.keys(oCompFns.cssBindings)
      const nCssBindingsVariables = Object.keys(nCompFns.cssBindings)
      // No v-bind() before and after the change
      if (oCssBindingsVariables.length === 0 && nCssBindingsVariables.length === 0) {
        patchRes.type = 'style'
        patchRes.scopeId = nCompFns.scopeId
      }
      // The variables of v-bind() before and after the change are equal
      else if (areStrArraysEqual(oCssBindingsVariables, nCssBindingsVariables)) {
        patchRes.type = 'style'
        patchRes.scopeId = nCompFns.scopeId
      }
      else {
        patchRes.type = 'module'
      }
      patchRes.hmrCompFnsName = nCompFns.fnName
      patchRes.scopeId = nCompFns.scopeId
      newVFCtx.renderOnly = false
    }
  }

  // If the number of components is different,
  // it means that the module has breaking change
  if (oVineCompFns.length !== nVineCompFns.length) {
    patchRes.hmrCompFnsName = null
    newVFCtx.renderOnly = false
    return patchRes
  }

  return patchRes
}
function patchVineFile(
  compilerCtx: VineCompilerCtx,
  compilerHooks: VineCompilerHooks,
  originVineFileCtx: VineFileCtx,
  modules: ModuleNode[],
  fileId: string,
  fileContent: string,
) {
  // file changed !
  if (fileContent === originVineFileCtx.originCode) {
    return
  }

  // analyze code again
  const newVineFileCtx: VineFileCtx = reAnalyzeVine(fileContent, fileId, compilerHooks)

  let patchRes: PatchModuleRes | null = null
  const affectedModules = new Set<ModuleNode>()

  const forEachImportedModule = (
    action: (importedModule: ModuleNode) => void,
  ) => {
    modules.forEach((m) => {
      const importedModules = m.importedModules
      if (importedModules.size > 0) {
        [...importedModules].forEach((im) => {
          if (!im.id) {
            return
          }

          action(im)
        })
      }
    })
  }

  // patch VineFileCtx, get patchRes
  forEachImportedModule((im) => {
    const { query } = parseQuery(im.id!)
    if (query.type === QUERY_TYPE_SCRIPT) {
      patchRes = patchModule(originVineFileCtx, newVineFileCtx)
    }
  })

  // find affected modules
  forEachImportedModule((im) => {
    const { query } = parseQuery(im.id!)
    if (query.type === QUERY_TYPE_STYLE
      && patchRes?.type
      && patchRes.scopeId === query.scopeId
      && patchRes.hmrCompFnsName
    ) {
      affectedModules.add(im)
    }
  })

  // update vineFileCtx
  if (patchRes) {
    newVineFileCtx.hmrCompFnsName = (patchRes as PatchModuleRes).hmrCompFnsName
  }
  compilerCtx.fileCtxMap.set(fileId, newVineFileCtx)
  compilerCtx.isRunningHMR = true

  if (!patchRes)
    return [...modules]
  const { type } = patchRes

  if (affectedModules.size > 0) {
    if (type === 'style') {
      return [...affectedModules]
    }
    else if (type === 'module') {
      return [...modules, ...affectedModules]
    }
  }

  return [...modules]
}

export async function vineHMR(
  ctx: HmrContext,
  compilerCtx: VineCompilerCtx,
  compilerHooks: VineCompilerHooks,
) {
  const { modules, file: fileId, read } = ctx
  const fileContent = await read()

  const originVineFileCtx = compilerCtx.fileCtxMap.get(fileId)
  if (originVineFileCtx) {
    return patchVineFile(
      compilerCtx,
      compilerHooks,
      originVineFileCtx,
      modules,
      fileId,
      fileContent,
    )
  }
}
