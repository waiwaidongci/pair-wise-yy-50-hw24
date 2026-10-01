// 预检条目 ↔ 问题指纹 ↔ 版位摘要 的映射。
// 每条校验规则产出稳定指纹；放行豁免只认指纹 + 当次摘要，
// 版位/出血/装订方向变化后指纹对应的依据即不成立。

import type { Position } from '../stores/imposition'
import type { IssueFingerprint, ScopeSnapshot } from './reviewLedger'

export const RULE_VERSION = 1

export type LayoutInput = {
  positions: Position[]
  pages: { pageNo: number; name: string; bleed: number }[]
  binding: string
  grain: string
  sheetBleed: number
}

export type IssueBinding = {
  fingerprint: IssueFingerprint
  scope: 'position' | 'page' | 'sheet'
  scopeRef: string
  scopeLabel: string
  scopeSnapshot: ScopeSnapshot
}

// 全张版位摘要：拖动版位、改正反面、换页都会改变
export function computeLayoutDigest(input: LayoutInput): string {
  const positionSig = input.positions
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => `${p.id}=P${p.pageNo}@${p.x},${p.y},r${p.rotation},${p.front ? 'F' : 'B'}`)
    .join(';')
  const bleedSig = input.pages
    .slice()
    .sort((a, b) => a.pageNo - b.pageNo)
    .map((p) => `P${p.pageNo}:b${p.bleed}`)
    .join(';')
  const raw = `${positionSig}|${bleedSig}|${input.binding}|${input.grain}`
  let hash = 0
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0
  }
  return `L${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function positionSnapshot(pos: Position) {
  return {
    id: pos.id,
    pageNo: pos.pageNo,
    x: pos.x,
    y: pos.y,
    rotation: pos.rotation,
    front: pos.front ? 1 : 0,
  }
}

function pagePositionSignature(pageNo: number, positions: Position[]): string {
  return positions
    .filter((p) => p.pageNo === pageNo)
    .map((p) => `${p.id}:${p.x},${p.y},${p.rotation},${p.front ? 1 : 0}`)
    .join('|')
}

// 校验规则与 store.validations 中的 id 一一对应，返回该条目的指纹与放行范围摘要
export function bindIssue(
  issueId: string,
  input: LayoutInput,
): IssueBinding | null {
  const { positions, pages } = input

  if (issueId.startsWith('missing-')) {
    const pageNo = Number(issueId.split('-')[1])
    const page = pages.find((p) => p.pageNo === pageNo)
    return {
      fingerprint: { code: 'missing', ruleVersion: RULE_VERSION, args: `P${pageNo}` },
      scope: 'page',
      scopeRef: `P${pageNo}`,
      scopeLabel: `P${pageNo} ${page?.name ?? ''} 尚未拼版`,
      scopeSnapshot: { pageNo, placed: 0, positionSig: '' },
    }
  }

  if (issueId.startsWith('bleed-')) {
    const pageNo = Number(issueId.split('-')[1])
    const page = pages.find((p) => p.pageNo === pageNo)
    return {
      fingerprint: { code: 'bleed', ruleVersion: RULE_VERSION, args: `P${pageNo}:b${page?.bleed}` },
      scope: 'page',
      scopeRef: `P${pageNo}`,
      scopeLabel: `P${pageNo} ${page?.name ?? ''} 出血 ${page?.bleed}mm`,
      scopeSnapshot: {
        pageNo,
        bleed: page?.bleed ?? 0,
        positionSig: pagePositionSignature(pageNo, positions),
      },
    }
  }

  if (issueId.startsWith('overlap-')) {
    const [, , aId, bId] = issueId.split('-')
    const a = positions.find((p) => p.id === aId)
    const b = positions.find((p) => p.id === bId)
    if (!a || !b) return null
    return {
      fingerprint: { code: 'overlap', ruleVersion: RULE_VERSION, args: `${aId}|${bId}` },
      scope: 'position',
      scopeRef: aId,
      scopeLabel: `${aId} 与 ${bId} 版位重叠`,
      scopeSnapshot: {
        ...positionSnapshot(a),
        other: bId,
        ox: b.x,
        oy: b.y,
      },
    }
  }

  if (issueId === 'binding-order') {
    const front = positions.filter((p) => p.front).sort((a, b) => a.x - b.x || a.y - b.y)
    return {
      fingerprint: { code: 'binding-order', ruleVersion: RULE_VERSION, args: `first=P${front[0]?.pageNo}` },
      scope: 'sheet',
      scopeRef: 'sheet',
      scopeLabel: '全张 · 骑马订页序与装订方向',
      scopeSnapshot: {
        binding: input.binding,
        grain: input.grain,
        order: front.map((p) => p.pageNo).join(','),
      },
    }
  }

  return null
}

// 当前某条预检问题是否仍存在（指纹重新匹配当前校验结果）
export function fingerprintMatchesIssue(fp: IssueFingerprint, currentIds: string[], input: LayoutInput): boolean {
  return currentIds.some((id) => {
    const binding = bindIssue(id, input)
    if (!binding) return false
    return binding.fingerprint.code === fp.code && binding.fingerprint.ruleVersion === fp.ruleVersion && binding.fingerprint.args === fp.args
  })
}
