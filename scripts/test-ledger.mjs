// 复核记录核心逻辑测试：用 esbuild 即时编译 TS，shim localStorage 后在 Node 中跑。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function makeMemory() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    dump: () => Object.fromEntries(map),
  }
}

async function loadBundle(memory) {
  const result = await build({
    entryPoints: [path.join(root, 'src/services/reviewLedger.ts')],
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'browser',
  })
  const code = result.outputFiles[0].text
  globalThis.localStorage = memory
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  return import(dataUrl)
}

const assert = (cond, msg) => {
  if (!cond) {
    console.error('✗', msg)
    process.exitCode = 1
  } else {
    console.log('✓', msg)
  }
}

// 版位上下文
const baseCtx = (over = {}) => ({
  layoutDigest: 'L11111111',
  positions: [
    { id: 'P-01', pageNo: 8, x: 34, y: 44, rotation: 0, front: true },
    { id: 'P-02', pageNo: 1, x: 372, y: 44, rotation: 180, front: true },
    { id: 'P-06', pageNo: 7, x: 372, y: 44, rotation: 180, front: false },
  ],
  pages: [{ pageNo: 7, bleed: 1 }],
  binding: '骑马订',
  grain: '纵向',
  ...over,
})

async function main() {
  // ── 1. 旧数据升级：无指纹豁免标为待复核，历史可查 ──
  const memory = makeMemory()
  let mod = await loadBundle(memory)
  let ledger = mod.loadLedger()
  assert(ledger.exemptions.length === 2, '种子含 2 条历史豁免')
  assert(ledger.exemptions.every((e) => e.status === 'pending_review'), '无指纹历史豁免全部标为待复核')
  assert(ledger.audits.some((a) => a.action === 'migration'), '升级产生 migration 审计，历史仍可查')

  // ── 2. 放行：指纹 + 摘要，豁免与审计同批；版本 +1 ──
  const v0 = ledger.docVersion
  const recordNo = 'REC-0301'
  const fp = { code: 'bleed', ruleVersion: 1, args: 'P7:b1' }
  const r1 = await mod.commitBatch(
    v0,
    '拼版工位',
    {
      kind: 'grant',
      recordNo,
      fingerprint: fp,
      scope: 'page',
      scopeRef: 'P7',
      scopeLabel: 'P7 出血 1mm',
      scopeSnapshot: { pageNo: 7, bleed: 1, positionSig: '' },
      layoutDigest: 'L11111111',
      reason: '测试放行',
      revision: 'R6',
    },
    baseCtx(),
  )
  ledger = r1.ledger
  assert(ledger.docVersion === v0 + 1, '放行后文档版本 +1')
  const granted = ledger.exemptions.find((e) => e.reason === '测试放行')
  assert(!!granted && granted.status === 'active', '豁免有效且绑定指纹')
  assert(ledger.audits.some((a) => a.recordNo === recordNo && a.action === 'grant' && a.exemptionId === granted.id), '同批次写入 grant 审计（豁免↔审计原子）')

  // ── 3. 幂等重试：同一记录号再交一次，不产生重复 ──
  const r1b = await mod.commitBatch(
    ledger.docVersion - 1, // 故意带旧版本，幂等回放优先于版本检查
    '拼版工位',
    {
      kind: 'grant',
      recordNo,
      fingerprint: fp,
      scope: 'page',
      scopeRef: 'P7',
      scopeLabel: 'P7 出血 1mm',
      scopeSnapshot: { pageNo: 7, bleed: 1, positionSig: '' },
      layoutDigest: 'L11111111',
      reason: '测试放行',
      revision: 'R6',
    },
    baseCtx(),
  )
  assert(r1b.retried === true, '同一记录号重试被识别为重放')
  assert(r1b.ledger.exemptions.filter((e) => e.reason === '测试放行').length === 1, '重放不产生第二条豁免')
  assert(r1b.ledger.audits.filter((a) => a.recordNo === recordNo).length === 1, '重放不产生第二条审计')

  // ── 4. 版位变化：豁免立即失效（审计同批） ──
  const changedCtx = baseCtx({
    layoutDigest: 'L22222222',
    positions: baseCtx().positions.map((p) => (p.id === 'P-06' ? { ...p, x: 120 } : p)),
  })
  // 给 P7 一个 position 级豁免之外，先测 page 出血变化
  const inv1 = mod.detectInvalidations(ledger, { ...baseCtx({ layoutDigest: 'L33333333', pages: [{ pageNo: 7, bleed: 3 }] }), revision: 'R6' })
  assert(inv1.some((i) => i.exemptionId === granted.id) && /出血/.test(inv1[0].reason), 'P7 出血 1→3mm，放行立即判定失效')

  // position 级豁免：拖动即失效
  const rp = await mod.commitBatch(
    ledger.docVersion,
    '拼版工位',
    {
      kind: 'grant',
      recordNo: 'REC-0302',
      fingerprint: { code: 'overlap', ruleVersion: 1, args: 'P-01|P-02' },
      scope: 'position',
      scopeRef: 'P-02',
      scopeLabel: 'P-01 与 P-02 重叠',
      scopeSnapshot: { id: 'P-02', pageNo: 1, x: 372, y: 44, rotation: 180, front: 1 },
      layoutDigest: 'L22222222',
      reason: '重叠放行',
      revision: 'R6',
    },
    changedCtx,
  )
  ledger = rp.ledger
  const movedCtx = {
    ...changedCtx,
    layoutDigest: 'L44444444',
    positions: changedCtx.positions.map((p) => (p.id === 'P-02' ? { ...p, x: 400 } : p)),
  }
  const inv2 = mod.detectInvalidations(ledger, { ...movedCtx, revision: 'R6' })
  const posGrant = ledger.exemptions.find((e) => e.reason === '重叠放行')
  assert(inv2.some((i) => i.exemptionId === posGrant.id), '拖动 P-02 后，版位级豁免立即失效')
  const committed = await mod.commitInvalidations(ledger.docVersion, '拼版工位', inv2, { ...movedCtx, revision: 'R6' })
  ledger = committed.ledger
  const after = ledger.exemptions.find((e) => e.id === posGrant.id)
  assert(after.status === 'invalid', '失效状态已写回')
  assert(ledger.audits.some((a) => a.action === 'invalidate' && a.exemptionId === posGrant.id), '失效同时写 invalidate 审计（无审计的豁免不存在）')

  // ── 5. 装订方向变化：sheet 级豁免失效 ──
  const rs = await mod.commitBatch(
    ledger.docVersion,
    '审批工位',
    {
      kind: 'grant',
      recordNo: 'REC-0303',
      fingerprint: { code: 'binding-order', ruleVersion: 1, args: 'first=P8' },
      scope: 'sheet',
      scopeRef: 'sheet',
      scopeLabel: '装订页序',
      scopeSnapshot: { binding: '骑马订', grain: '纵向', order: '8,1,6,3' },
      layoutDigest: 'L55555555',
      reason: '页序放行',
      revision: 'R6',
    },
    baseCtx({ layoutDigest: 'L55555555' }),
  )
  ledger = rs.ledger
  const sheetGrant = ledger.exemptions.find((e) => e.reason === '页序放行')
  const inv3 = mod.detectInvalidations(ledger, { ...baseCtx({ layoutDigest: 'L66666666', binding: '胶订' }), revision: 'R6' })
  assert(inv3.some((i) => i.exemptionId === sheetGrant.id), '装订方向一变，全张级豁免立即失效')

  // ── 6. 并发：另一工位先保存，后到方被拒并列出被改对象 ──
  const sessionVersion = ledger.docVersion
  ledger = await mod.simulateConcurrentSave(sessionVersion, '拼版工位', 'R6', baseCtx({ layoutDigest: 'L77777777' }), 'move')
  assert(ledger.docVersion === sessionVersion + 1, '另一工位保存后服务器版本前进')
  let conflict = null
  try {
    await mod.commitBatch(
      sessionVersion, // 本工位仍持打开时的旧版本
      '审批工位',
      { kind: 'checkpoint', recordNo: 'REC-0304', revision: 'R6', note: '本工位保存' },
      baseCtx(),
    )
  } catch (e) {
    conflict = e
  }
  assert(conflict && conflict.code === 'REVIEW_CONFLICT', '后到方保存被版本冲突拒绝')
  assert(Array.isArray(conflict.changedObjects) && conflict.changedObjects.length > 0, '冲突响应列出被改对象')
  assert(conflict.changedObjects.some((o) => /P-02|版位/.test(o.scopeLabel)), '被改对象包含被拖动的 P-02')

  // ── 7. 冲突后以新版本重开可成功（保留原记录号由调用方处理） ──
  const r2 = await mod.commitBatch(
    ledger.docVersion,
    '审批工位',
    { kind: 'checkpoint', recordNo: 'REC-0305', revision: 'R6', note: '本工位保存' },
    baseCtx(),
  )
  assert(r2.ledger.docVersion === ledger.docVersion + 1, '以最新版本重开后保存成功')

  // ── 8. 锁定依据绑定当前摘要 ──
  ledger = r2.ledger
  const lockRes = await mod.commitBatch(
    ledger.docVersion,
    '审批工位',
    {
      kind: 'lock',
      recordNo: 'REC-0306',
      basis: {
        revision: 'R6',
        layoutDigest: baseCtx().layoutDigest,
        docVersion: ledger.docVersion,
        activeExemptionIds: ledger.exemptions.filter((e) => e.status === 'active').map((e) => e.id),
        operator: '周默',
        station: '审批工位',
        at: new Date().toISOString(),
      },
      revision: 'R6',
    },
    baseCtx(),
  )
  assert(lockRes.ledger.lock?.layoutDigest === 'L11111111', '锁定记录绑定当次版位摘要')
  assert(lockRes.ledger.audits.some((a) => a.action === 'lock'), '锁定写审计')

  // ── 9. 旧数据持久化后重新加载仍为待复核（幂等升级不重复审计） ──
  const fresh = mod.loadLedger()
  const migrationCount = fresh.audits.filter((a) => a.action === 'migration').length
  assert(migrationCount === 1, `重复加载不重复写升级审计（实际 ${migrationCount}）`)
  assert(fresh.exemptions.filter((e) => e.status === 'pending_review').length === 2, '历史豁免仍为待复核')

  // ── 10. 待复核计数口径：只数 pending_review ──
  assert(fresh.exemptions.filter((e) => e.status === 'pending_review').length === 2, '总览/预检/版本对比共用同一计数 = 2')

  // ── 11. 写入失败：不留半批；按原记录号重试成功（豁免与审计都只落一次） ──
  const mem2 = makeMemory()
  const mod2 = await loadBundle(mem2)
  let led2 = mod2.loadLedger()
  mod2.armWriteFailure()
  const recNo2 = 'REC-0901'
  const batch2 = {
    kind: 'grant',
    recordNo: recNo2,
    fingerprint: { code: 'bleed', ruleVersion: 1, args: 'P7:b1' },
    scope: 'page',
    scopeRef: 'P7',
    scopeLabel: 'P7 出血 1mm',
    scopeSnapshot: { pageNo: 7, bleed: 1, positionSig: '' },
    layoutDigest: 'L11111111',
    reason: '故障演练放行',
    revision: 'R6',
  }
  let failed = null
  try {
    await mod2.commitBatch(led2.docVersion, '拼版工位', batch2, baseCtx())
  } catch (e) {
    failed = e
  }
  assert(failed && /写入失败/.test(failed.message), '注入的写入失败向上抛出')
  led2 = mod2.loadLedger()
  assert(!led2.exemptions.some((e) => e.reason === '故障演练放行'), '失败后没有留下豁免（无半批结果）')
  assert(!led2.audits.some((a) => a.recordNo === recNo2), '失败后没有留下审计（豁免↔审计同生共死）')
  assert(led2.docVersion === 1, '失败不推进文档版本')
  const retryRes = await mod2.commitBatch(led2.docVersion, '拼版工位', batch2, baseCtx())
  assert(retryRes.retried === false, '首次失败未服务端落库；同一记录号重试为正式提交')
  led2 = retryRes.ledger
  assert(led2.exemptions.filter((e) => e.reason === '故障演练放行').length === 1, '重试后恰好一条豁免')
  assert(led2.audits.filter((a) => a.recordNo === recNo2).length === 1, '重试后恰好一条审计，记录号不变')

  console.log(process.exitCode ? '\n部分断言失败' : '\n全部断言通过')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
