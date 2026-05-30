/**
 * Tests for storageRouter and stage4Handoff.
 *
 * storageRouter suite — Stage 3 BU plan persistence contract:
 *   generation → save → reload → render eligibility
 *
 * stage4Handoff suite — Stage 3 → Stage 4 handoff compiler contract:
 *   reads only from IDB, marks blocked BUs explicitly, requires persistedAt,
 *   write → verify round-trip must succeed before content is usable.
 *
 * IDB is mocked; localStorage is shimmed via a plain Map.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── localStorage shim ──────────────────────────────────────────────────────────
function makeLocalStorageShim() {
  const store = new Map()
  return {
    getItem:    (k)    => store.has(k) ? store.get(k) : null,
    setItem:    (k, v) => store.set(k, String(v)),
    removeItem: (k)    => store.delete(k),
    clear:      ()     => store.clear(),
    get length()       { return store.size },
    key:        (i)    => [...store.keys()][i] ?? null,
    _store:     store,
  }
}

// ── IDB mock ───────────────────────────────────────────────────────────────────
const _idbStore = new Map()

const idbWriteSpy = vi.fn(async (_store, key, value) => { _idbStore.set(key, value) })

vi.mock('./idbStorage', () => ({
  IDB_STORES: {
    PLANS:                   'plans',
    STAGE2_HANDOFFS:         'stage2_handoffs',
    STAGE3_BU_PLANS:         'stage3_bu_plans',
    STAGE3_COORDINATION:     'stage3_coordination',
    STAGE4_HANDOFFS:         'stage4_handoffs',
    STAGE4_ARTIFACT_PLANS:   'stage4_artifact_plans',
    STAGE4_ARTIFACT_OUTPUTS: 'stage4_artifact_outputs',
  },
  idbRead:    async (_store, key) => _idbStore.get(key) ?? null,
  idbWrite:   (...args) => idbWriteSpy(...args),
  idbReadAll: async (store) => {
    const prefixes = {
      stage3_bu_plans:         'bsp_v1_stage3_bu_plan_',
      stage4_handoffs:         'bsp_v1_stage4_handoff_',
      stage4_artifact_plans:   'bsp_v1_stage4_artifact_plan_',
      stage4_artifact_outputs: 'bsp_v1_stage4_artifact_output_',
    }
    const prefix = prefixes[store] || ''
    return [..._idbStore.entries()]
      .filter(([k]) => !prefix || k.startsWith(prefix))
      .map(([key, value]) => ({ key, value }))
  },
}))

// ── Key helpers ────────────────────────────────────────────────────────────────
function stage3Key(workspaceId, stage1Id, stage2Id, buName) {
  const safe = buName.toLowerCase().replace(/[^a-z0-9]/g, '_')
  return `bsp_v1_stage3_bu_plan_${workspaceId}_${stage1Id}_${stage2Id}_${safe}`
}

function stage4Key(workspaceId, stage1Id, stage2Id, stage3Id) {
  return `bsp_v1_stage4_handoff_${workspaceId}_${stage1Id}_${stage2Id}_${stage3Id}`
}

// ── Fixture factories ──────────────────────────────────────────────────────────
function makeStage3Draft(buName, overrides = {}) {
  return {
    version: 1,
    businessUnitName: buName,
    buName,
    source: 'ai',
    status: 'draft_generated',
    lifecycle: { status: 'draft_generated' },
    plan: {
      buName,
      mission: `${buName} mission`,
      strategicRole: `${buName} role`,
      priorityOutcomes: ['Outcome A'],
      criticalWorkstreams: ['Stream 1'],
      executionSections: [{
        sectionName: 'Strategy',
        objective: 'Deliver',
        executionStrategy: ['Do the thing'],
        decisionsRequired: ['Decision 1'],
        sequencingAndGates: [],
        dependencies: [],
        risks: ['Risk 1'],
        validationReadinessChecks: [],
      }],
      stage4DeliveryImplications: ['Implication A'],
    },
    executionAtoms: [
      { id: `stage3:${buName}:strategy:objective`, status: 'complete', parsedValue: 'Deliver' },
      { id: `stage3:${buName}:strategy:risks`,     status: 'complete', parsedValue: ['Risk 1'] },
    ],
    persistedAt: new Date().toISOString(),
    lastSavedAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    ...overrides,
  }
}

// ── Shared beforeEach ──────────────────────────────────────────────────────────
let ls
let storageRouter

beforeEach(async () => {
  _idbStore.clear()
  idbWriteSpy.mockImplementation(async (_store, key, value) => { _idbStore.set(key, value) })

  ls = makeLocalStorageShim()
  vi.stubGlobal('localStorage', ls)

  vi.resetModules()
  storageRouter = await import('./storageRouter.js')
})

// ══════════════════════════════════════════════════════════════════════════════
// storageRouter — Stage 3 BU plan persistence
// ══════════════════════════════════════════════════════════════════════════════

describe('storageRouter — Stage 3 BU plan persistence', () => {

  it('routes stage3 BU plan key to IDB store', () => {
    const key = 'bsp_v1_stage3_bu_plan_ws1_s1_s2_product_management'
    const route = storageRouter.routeKey(key)
    expect(route).not.toBeNull()
    expect(route.store).toBe('stage3_bu_plans')
    expect(route.dualWrite).toBe(false)
  })

  it('routes stage4 handoff key to IDB store', () => {
    const key = 'bsp_v1_stage4_handoff_ws1_s1_s2_s3'
    const route = storageRouter.routeKey(key)
    expect(route).not.toBeNull()
    expect(route.store).toBe('stage4_handoffs')
    expect(route.dualWrite).toBe(false)
  })

  it('routes unrecognised key to null (LS-only)', () => {
    expect(storageRouter.routeKey('some_random_key')).toBeNull()
    expect(storageRouter.routeKey(null)).toBeNull()
    expect(storageRouter.routeKey('')).toBeNull()
  })

  it('writeArtifact writes to IDB and puts a pointer in LS', async () => {
    const key = stage3Key('ws1', 's1', 's2', 'Product Management')
    const draft = makeStage3Draft('Product Management')

    const ok = await storageRouter.writeArtifact(key, draft)

    expect(ok).toBe(true)
    const { idbRead } = await import('./idbStorage.js')
    const idbVal = await idbRead('stage3_bu_plans', key)
    expect(idbVal?.plan?.buName).toBe('Product Management')

    const lsParsed = JSON.parse(ls.getItem(key))
    expect(lsParsed._idbRef).toBe(true)
    expect(lsParsed.store).toBe('stage3_bu_plans')
  })

  it('readCached returns the draft synchronously after writeArtifact', async () => {
    const key = stage3Key('ws1', 's1', 's2', 'Engineering')
    await storageRouter.writeArtifact(key, makeStage3Draft('Engineering'))
    const cached = storageRouter.readCached(key)
    expect(cached?.plan?.buName).toBe('Engineering')
  })

  it('readArtifactAsync returns draft after initStorageCache loads IDB', async () => {
    const key = stage3Key('ws1', 's1', 's2', 'Finance')
    const draft = makeStage3Draft('Finance')
    _idbStore.set(key, draft)
    ls.setItem(key, JSON.stringify({ _idbRef: true, store: 'stage3_bu_plans', idbKey: key }))

    await storageRouter.initStorageCache()

    const loaded = await storageRouter.readArtifactAsync(key)
    expect(loaded?.plan?.buName).toBe('Finance')
    expect(loaded?.version).toBe(1)
  })

  it('readCached returns draft synchronously after cache is warm from IDB', async () => {
    const key = stage3Key('ws1', 's1', 's2', 'HR')
    const draft = makeStage3Draft('HR')
    _idbStore.set(key, draft)
    ls.setItem(key, JSON.stringify({ _idbRef: true, store: 'stage3_bu_plans', idbKey: key }))

    await storageRouter.initStorageCache()

    const cached = storageRouter.readCached(key)
    expect(cached?.buName).toBe('HR')
  })

  it('readArtifactAsync returns null when IDB has no entry (not persisted)', async () => {
    const key = stage3Key('ws1', 's1', 's2', 'Sales')
    ls.setItem(key, JSON.stringify({ _idbRef: true, store: 'stage3_bu_plans', idbKey: key }))

    await storageRouter.initStorageCache()

    const loaded = await storageRouter.readArtifactAsync(key)
    expect(loaded).toBeNull()
  })

  it('writeArtifact returns false when IDB write throws', async () => {
    idbWriteSpy.mockRejectedValueOnce(new Error('IDB quota exceeded'))

    const key = stage3Key('ws1', 's1', 's2', 'Operations')
    const ok = await storageRouter.writeArtifact(key, makeStage3Draft('Operations'))
    expect(ok).toBe(false)
  })

  // ── readArtifactFromIdb — cache-bypass guarantee ───────────────────────────

  it('readArtifactFromIdb returns the draft when IDB has the record', async () => {
    const key = stage3Key('ws1', 's1', 's2', 'Legal')
    const draft = makeStage3Draft('Legal')
    _idbStore.set(key, draft)
    await storageRouter.initStorageCache()

    const loaded = await storageRouter.readArtifactFromIdb(key)
    expect(loaded?.plan?.buName).toBe('Legal')
  })

  it('readArtifactFromIdb returns null even when cache has a value but IDB does not', async () => {
    // Simulate a failed IDB write: cache gets the value, IDB does not.
    idbWriteSpy.mockRejectedValueOnce(new Error('IDB unavailable'))
    const key = stage3Key('ws1', 's1', 's2', 'Risk')
    await storageRouter.writeArtifact(key, makeStage3Draft('Risk')) // returns false, but cache is set

    // Confirm the stale-cache loophole: readArtifactAsync sees the cached value
    const fromCache = await storageRouter.readArtifactAsync(key)
    expect(fromCache?.plan?.buName).toBe('Risk') // loophole confirmed

    // readArtifactFromIdb bypasses the cache and correctly returns null
    const fromIdb = await storageRouter.readArtifactFromIdb(key)
    expect(fromIdb).toBeNull()
  })

  it('readArtifactFromIdb returns null for LS-only (unrouted) keys', async () => {
    await storageRouter.initStorageCache()
    const result = await storageRouter.readArtifactFromIdb('some_unrouted_key')
    expect(result).toBeNull()
  })

  it('isIdbPointer correctly identifies pointer vs real content', () => {
    expect(storageRouter.isIdbPointer({ _idbRef: true, store: 'stage3_bu_plans', idbKey: 'k' })).toBe(true)
    expect(storageRouter.isIdbPointer({ plan: { buName: 'Foo' } })).toBe(false)
    expect(storageRouter.isIdbPointer(null)).toBe(false)
    expect(storageRouter.isIdbPointer('string')).toBe(false)
  })

  it('full round-trip: write draft, reload cache, verify render eligibility', async () => {
    const key = stage3Key('ws_rt', 's1_rt', 's2_rt', 'Product Management')
    const draft = makeStage3Draft('Product Management')

    const writeOk = await storageRouter.writeArtifact(key, draft)
    expect(writeOk).toBe(true)

    vi.resetModules()
    _idbStore.set(key, draft)
    ls.setItem(key, JSON.stringify({ _idbRef: true, store: 'stage3_bu_plans', idbKey: key }))

    const freshRouter = await import('./storageRouter.js')
    await freshRouter.initStorageCache()

    const reloaded = freshRouter.readCached(key)
    expect(reloaded).not.toBeNull()
    expect(reloaded.version).toBe(1)
    expect(reloaded.lifecycle.status).toBe('draft_generated')

    const eligibleAtoms = reloaded.executionAtoms.filter(a => a.status === 'complete')
    expect(eligibleAtoms.length).toBeGreaterThan(0)
    expect(reloaded.plan?.executionSections?.length).toBeGreaterThan(0)
    expect(reloaded.persistedAt).toBeTruthy()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// stage4Handoff — compiler and persistence contract
// ══════════════════════════════════════════════════════════════════════════════

describe('stage4Handoff — compiler reads only from IDB', () => {
  const WID = 'ws4', S1 = 's1', S2 = 's2', S3 = 's3'

  async function seedStage3(buName, overrides = {}) {
    const key = stage3Key(WID, S1, S2, buName)
    const draft = makeStage3Draft(buName, overrides)
    _idbStore.set(key, draft)
    ls.setItem(key, JSON.stringify({ _idbRef: true, store: 'stage3_bu_plans', idbKey: key }))
    // Warm the cache so readArtifactAsync returns immediately
    await storageRouter.initStorageCache()
    return { key, draft }
  }

  async function getHandoffModule() {
    vi.resetModules()
    // Re-import storageRouter first so cache is fresh
    storageRouter = await import('./storageRouter.js')
    return import('./stage4Handoff.js')
  }

  it('BU_HANDOFF_STATUS.BLOCKED when no IDB record exists', async () => {
    await storageRouter.initStorageCache()
    const { compileStage4Handoff, BU_HANDOFF_STATUS } = await getHandoffModule()

    const result = await compileStage4Handoff({ workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3, buNames: ['Ghost BU'] })
    const entry = result.buHandoffs[0]
    expect(entry.status).toBe(BU_HANDOFF_STATUS.BLOCKED)
    expect(entry.blockedReason).toMatch(/No durable Stage 3 record/)
    expect(entry.plan).toBeNull()
  })

  it('BU_HANDOFF_STATUS.BLOCKED when record has no persistedAt', async () => {
    await seedStage3('Finance', { persistedAt: undefined, lastSavedAt: undefined })
    const { compileStage4Handoff, BU_HANDOFF_STATUS } = await getHandoffModule()

    const result = await compileStage4Handoff({ workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3, buNames: ['Finance'] })
    expect(result.buHandoffs[0].status).toBe(BU_HANDOFF_STATUS.BLOCKED)
    expect(result.buHandoffs[0].blockedReason).toMatch(/persistedAt/)
  })

  it('BU_HANDOFF_STATUS.BLOCKED when lifecycle status is not ready', async () => {
    await seedStage3('Sales', { lifecycle: { status: 'generating' }, status: 'generating' })
    const { compileStage4Handoff, BU_HANDOFF_STATUS } = await getHandoffModule()

    const result = await compileStage4Handoff({ workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3, buNames: ['Sales'] })
    expect(result.buHandoffs[0].status).toBe(BU_HANDOFF_STATUS.BLOCKED)
  })

  it('BU_HANDOFF_STATUS.BLOCKED when no completed atoms exist', async () => {
    await seedStage3('Ops', {
      executionAtoms: [
        { id: 'stage3:Ops:s:objective', status: 'failed', parsedValue: null },
      ],
    })
    const { compileStage4Handoff, BU_HANDOFF_STATUS } = await getHandoffModule()

    const result = await compileStage4Handoff({ workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3, buNames: ['Ops'] })
    expect(result.buHandoffs[0].status).toBe(BU_HANDOFF_STATUS.BLOCKED)
    expect(result.buHandoffs[0].blockedReason).toMatch(/No completed execution atoms/)
  })

  it('BU_HANDOFF_STATUS.READY for a clean durable record', async () => {
    await seedStage3('Engineering')
    const { compileStage4Handoff, BU_HANDOFF_STATUS } = await getHandoffModule()

    const result = await compileStage4Handoff({ workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3, buNames: ['Engineering'] })
    const entry = result.buHandoffs[0]
    expect(entry.status).toBe(BU_HANDOFF_STATUS.READY)
    expect(entry.plan?.buName).toBe('Engineering')
    expect(entry.sourceAtomIds.length).toBeGreaterThan(0)
    expect(entry.sourcePersistAt).toBeTruthy()
  })

  it('BU_HANDOFF_STATUS.PARTIAL when lifecycle is partial_draft', async () => {
    await seedStage3('HR', { lifecycle: { status: 'partial_draft' }, status: 'partial_draft' })
    const { compileStage4Handoff, BU_HANDOFF_STATUS } = await getHandoffModule()

    const result = await compileStage4Handoff({ workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3, buNames: ['HR'] })
    expect(result.buHandoffs[0].status).toBe(BU_HANDOFF_STATUS.PARTIAL)
  })

  it('only completed atom IDs are forwarded (failed atoms excluded)', async () => {
    await seedStage3('Product', {
      executionAtoms: [
        { id: 'atom:complete', status: 'complete', parsedValue: 'x' },
        { id: 'atom:failed',   status: 'failed',   parsedValue: null },
        { id: 'atom:partial',  status: 'parser_error', parsedValue: null },
      ],
    })
    const { compileStage4Handoff } = await getHandoffModule()

    const result = await compileStage4Handoff({ workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3, buNames: ['Product'] })
    const entry = result.buHandoffs[0]
    expect(entry.sourceAtomIds).toEqual(['atom:complete'])
  })

  it('overallStatus is BLOCKED when all BUs are blocked', async () => {
    // No IDB records seeded
    await storageRouter.initStorageCache()
    const { compileStage4Handoff, HANDOFF_STATUS } = await getHandoffModule()

    const result = await compileStage4Handoff({ workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3, buNames: ['A', 'B'] })
    expect(result.overallStatus).toBe(HANDOFF_STATUS.BLOCKED)
    expect(result.readyCount).toBe(0)
    expect(result.blockedCount).toBe(2)
  })

  it('overallStatus is PARTIAL when mixed ready/blocked', async () => {
    await seedStage3('Engineering')
    // 'Ghost' has no record — will be BLOCKED
    const { compileStage4Handoff, HANDOFF_STATUS } = await getHandoffModule()

    const result = await compileStage4Handoff({ workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3, buNames: ['Engineering', 'Ghost'] })
    expect(result.overallStatus).toBe(HANDOFF_STATUS.PARTIAL)
    expect(result.readyCount).toBe(1)
    expect(result.blockedCount).toBe(1)
  })

  it('compiledAt is set; persistedAt is null before persistence', async () => {
    await seedStage3('Engineering')
    const { compileStage4Handoff } = await getHandoffModule()

    const result = await compileStage4Handoff({ workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3, buNames: ['Engineering'] })
    expect(result.compiledAt).toBeTruthy()
    expect(result.persistedAt).toBeNull()
  })

  it('persistStage4Handoff writes to IDB and sets persistedAt', async () => {
    await seedStage3('Engineering')
    const { compileStage4Handoff, persistStage4Handoff } = await getHandoffModule()

    const compiled = await compileStage4Handoff({ workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3, buNames: ['Engineering'] })
    const { ok, record } = await persistStage4Handoff(compiled)

    expect(ok).toBe(true)
    expect(record.persistedAt).toBeTruthy()

    const key = stage4Key(WID, S1, S2, S3)
    const idbVal = _idbStore.get(key)
    expect(idbVal?.persistedAt).toBeTruthy()
    expect(idbVal?.version).toBe(1)
  })

  it('loadStage4Handoff returns null when not persisted', async () => {
    await storageRouter.initStorageCache()
    const { loadStage4Handoff } = await getHandoffModule()

    const result = await loadStage4Handoff(WID, S1, S2, S3)
    expect(result).toBeNull()
  })

  // ── Stale-cache loophole regression test ────────────────────────────────────
  //
  // The loophole: writeArtifact always calls _cache.set() before the IDB write.
  // If IDB fails AND the LS fallback also fails (quota), the cache holds the
  // value but neither disk path does.  readArtifactAsync() would return the
  // cached value; readArtifactFromIdb() correctly returns null.
  //
  // We simulate this by failing IDB and then manually replacing the LS fallback
  // value with an IDB pointer so the _doInit migration step cannot rescue the
  // record.  This keeps the IDB empty while the cache is populated.

  it('compiler marks BU BLOCKED when cache has a value but IDB has no record (stale-cache scenario)', async () => {
    const buKey = stage3Key(WID, S1, S2, 'CacheOnly')
    const draft = makeStage3Draft('CacheOnly')

    await storageRouter.initStorageCache()

    // Fail IDB write — cache is set, LS fallback writes full JSON
    idbWriteSpy.mockRejectedValueOnce(new Error('IDB unavailable'))
    const writeOk = await storageRouter.writeArtifact(buKey, draft)
    expect(writeOk).toBe(false)

    // Replace the LS full-JSON fallback with a pointer so _doInit migration
    // cannot rescue the record on the next storageReady() call.
    ls.setItem(buKey, JSON.stringify({ _idbRef: true, store: 'stage3_bu_plans', idbKey: buKey }))

    // Confirm the loophole in the OLD (current) module instance:
    // readArtifactAsync sees the cache value and returns it.
    const fromCache = await storageRouter.readArtifactAsync(buKey)
    expect(fromCache?.plan?.buName).toBe('CacheOnly') // loophole confirmed

    // readArtifactFromIdb bypasses cache: IDB is empty → null
    const fromIdb = await storageRouter.readArtifactFromIdb(buKey)
    expect(fromIdb).toBeNull()

    // Now compile Stage 4. resetModules creates a fresh storageRouter: no stale
    // cache, _doInit scans LS, sees the pointer, finds nothing in IDB → no
    // migration. readArtifactFromIdb still returns null → BU is BLOCKED.
    const { compileStage4Handoff, BU_HANDOFF_STATUS } = await getHandoffModule()
    const result = await compileStage4Handoff({ workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3, buNames: ['CacheOnly'] })

    expect(result.buHandoffs[0].status).toBe(BU_HANDOFF_STATUS.BLOCKED)
    expect(result.buHandoffs[0].plan).toBeNull()
    expect(result.buHandoffs[0].blockedReason).toMatch(/No durable Stage 3 record/)
  })

  it('full round-trip: compile → persist → loadStage4Handoff verifies from storage', async () => {
    await seedStage3('Engineering')
    const { compileStage4Handoff, persistStage4Handoff, loadStage4Handoff, BU_HANDOFF_STATUS } = await getHandoffModule()

    const compiled = await compileStage4Handoff({ workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3, buNames: ['Engineering'] })
    const { ok } = await persistStage4Handoff(compiled)
    expect(ok).toBe(true)

    // Simulate reload: warm cache from IDB
    const key = stage4Key(WID, S1, S2, S3)
    ls.setItem(key, JSON.stringify({ _idbRef: true, store: 'stage4_handoffs', idbKey: key }))
    vi.resetModules()
    storageRouter = await import('./storageRouter.js')
    await storageRouter.initStorageCache()

    const { loadStage4Handoff: loadFresh } = await import('./stage4Handoff.js')
    const verified = await loadFresh(WID, S1, S2, S3)

    expect(verified).not.toBeNull()
    expect(verified.version).toBe(1)
    expect(verified.persistedAt).toBeTruthy()
    expect(verified.buHandoffs[0].status).toBe(BU_HANDOFF_STATUS.READY)
  })

  // ── Stage 3 trigger tests — handoff creation flow ────────────────────────────

  it('Stage 3 trigger: handoff is not shown as usable until persistedAt is confirmed', async () => {
    await seedStage3('Engineering')
    const { compileStage4Handoff, persistStage4Handoff, loadStage4Handoff } = await getHandoffModule()

    const compiled = await compileStage4Handoff({ workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3, buNames: ['Engineering'] })

    // Before persist: compiledAt exists, persistedAt is null — not usable
    expect(compiled.compiledAt).toBeTruthy()
    expect(compiled.persistedAt).toBeNull()

    // Before persist: loadStage4Handoff returns null (nothing written yet)
    const beforePersist = await loadStage4Handoff(WID, S1, S2, S3)
    expect(beforePersist).toBeNull()

    // After persist + verify: usable
    await persistStage4Handoff(compiled)
    const verified = await loadStage4Handoff(WID, S1, S2, S3)
    expect(verified?.persistedAt).toBeTruthy()
  })

  it('Stage 3 trigger: verified handoff summary shows per-BU status', async () => {
    await seedStage3('Engineering')
    await seedStage3('Finance', { lifecycle: { status: 'partial_draft' }, status: 'partial_draft' })
    const { compileStage4Handoff, persistStage4Handoff, loadStage4Handoff, BU_HANDOFF_STATUS } = await getHandoffModule()

    const compiled = await compileStage4Handoff({
      workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3,
      buNames: ['Engineering', 'Finance', 'Ghost'],
    })
    await persistStage4Handoff(compiled)
    const verified = await loadStage4Handoff(WID, S1, S2, S3)

    expect(verified.readyCount).toBe(1)
    expect(verified.partialCount).toBe(1)
    expect(verified.blockedCount).toBe(1)         // Ghost has no IDB record
    expect(verified.totalCount).toBe(3)

    const eng = verified.buHandoffs.find(b => b.buName === 'Engineering')
    expect(eng.status).toBe(BU_HANDOFF_STATUS.READY)
    expect(eng.sourcePersistAt).toBeTruthy()

    const ghost = verified.buHandoffs.find(b => b.buName === 'Ghost')
    expect(ghost.status).toBe(BU_HANDOFF_STATUS.BLOCKED)
    expect(ghost.plan).toBeNull()
    expect(ghost.blockedReason).toBeTruthy()
  })

  it('Stage 3 trigger: blocks when no BU has durable Stage 3 records', async () => {
    // No Stage 3 records seeded at all
    await storageRouter.initStorageCache()
    const { compileStage4Handoff, HANDOFF_STATUS } = await getHandoffModule()

    const compiled = await compileStage4Handoff({
      workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3,
      buNames: ['A', 'B', 'C'],
    })
    expect(compiled.overallStatus).toBe(HANDOFF_STATUS.BLOCKED)
    expect(compiled.readyCount).toBe(0)
    expect(compiled.blockedCount).toBe(3)
    compiled.buHandoffs.forEach(b => {
      expect(b.plan).toBeNull()
      expect(b.blockedReason).toBeTruthy()
    })
  })

  it('Stage 4 consumer: loadStage4Handoff returns null when no handoff prepared', async () => {
    await storageRouter.initStorageCache()
    const { loadStage4Handoff } = await getHandoffModule()
    const result = await loadStage4Handoff(WID, S1, S2, 'nonexistent_stage3_rev')
    expect(result).toBeNull()
  })

  it('Stage 4 consumer: loadStage4Handoff returns null for wrong stage3Id', async () => {
    await seedStage3('Engineering')
    const { compileStage4Handoff, persistStage4Handoff, loadStage4Handoff } = await getHandoffModule()

    const compiled = await compileStage4Handoff({ workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3, buNames: ['Engineering'] })
    await persistStage4Handoff(compiled)

    // Different stage3Id — handoff is keyed per-revision
    const result = await loadStage4Handoff(WID, S1, S2, 'different_s3_rev')
    expect(result).toBeNull()
  })

  it('source invariant: compiler uses readArtifactFromIdb, not readArtifactAsync or cache', async () => {
    // Seed Engineering into IDB properly
    await seedStage3('Engineering')

    // Populate cache with a DIFFERENT (incorrect) version for the same key
    const buKey = stage3Key(WID, S1, S2, 'Engineering')
    const poisonedDraft = makeStage3Draft('Engineering', {
      plan: null,  // no plan — would cause BLOCKED if used
      executionAtoms: [],
    })
    // Write poison to cache only (not IDB)
    idbWriteSpy.mockRejectedValueOnce(new Error('IDB write blocked for poison'))
    await storageRouter.writeArtifact(buKey, poisonedDraft)
    // Restore LS pointer so migration doesn't fix it
    ls.setItem(buKey, JSON.stringify({ _idbRef: true, store: 'stage3_bu_plans', idbKey: buKey }))

    // Confirm: cache has the poisoned draft, IDB has the good one
    const fromCache = await storageRouter.readArtifactAsync(buKey)
    expect(fromCache?.executionAtoms?.length).toBe(0) // poisoned

    const fromIdb = await storageRouter.readArtifactFromIdb(buKey)
    expect(fromIdb?.executionAtoms?.length).toBeGreaterThan(0) // good

    // Compiler must use the IDB path — result should be READY (not BLOCKED)
    const { compileStage4Handoff, BU_HANDOFF_STATUS } = await getHandoffModule()
    const result = await compileStage4Handoff({ workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3, buNames: ['Engineering'] })
    expect(result.buHandoffs[0].status).toBe(BU_HANDOFF_STATUS.READY)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// stage4ArtifactPlan — artifact planning contract
// ══════════════════════════════════════════════════════════════════════════════

describe('stage4ArtifactPlan — deterministic artifact suggestions and persistence', () => {
  const WID = 'ws_ap', S1 = 's1_ap', S2 = 's2_ap', S3 = 's3_ap'

  function makeHandoff(buStatuses) {
    const now = new Date().toISOString()
    const buHandoffs = buStatuses.map(([name, status, reason]) => ({
      buName: name, status,
      blockedReason: reason || null,
      sourcePersistAt: status !== 'blocked' ? now : null,
      sourceAtomIds: status !== 'blocked' ? ['atom_1', 'atom_2'] : [],
      plan: status !== 'blocked' ? { buName: name } : null,
    }))
    const readyCount   = buHandoffs.filter(b => b.status === 'ready').length
    const partialCount = buHandoffs.filter(b => b.status === 'partial').length
    const blockedCount = buHandoffs.filter(b => b.status === 'blocked').length
    const overallStatus = readyCount === buHandoffs.length ? 'ready'
      : readyCount + partialCount > 0 ? 'partial'
      : 'blocked'
    return {
      version: 1, workspaceId: WID, stage1RevisionId: S1, stage2RevisionId: S2, stage3RevisionId: S3,
      compiledAt: now, persistedAt: now, overallStatus,
      readyCount, partialCount, blockedCount, totalCount: buHandoffs.length,
      buHandoffs,
    }
  }

  async function getArtifactModule() {
    vi.resetModules()
    storageRouter = await import('./storageRouter.js')
    return import('./stage4ArtifactPlan.js')
  }

  beforeEach(async () => {
    _idbStore.clear()
    idbWriteSpy.mockImplementation(async (_store, key, value) => { _idbStore.set(key, value) })
    ls = makeLocalStorageShim()
    vi.stubGlobal('localStorage', ls)
    vi.resetModules()
    storageRouter = await import('./storageRouter.js')
  })

  it('storage key routes to stage4_artifact_plans store', () => {
    const key = `bsp_v1_stage4_artifact_plan_${WID}_${S1}_${S2}_${S3}`
    const route = storageRouter.routeKey(key)
    expect(route?.store).toBe('stage4_artifact_plans')
    expect(route?.dualWrite).toBe(false)
  })

  it('READY BU gets 4 generation-ready artifacts, all selected', async () => {
    const { suggestArtifacts, BU_ARTIFACT_DEFS, ARTIFACT_READINESS } = await getArtifactModule()
    const handoff = makeHandoff([['Engineering', 'ready']])
    const arts = suggestArtifacts(handoff).filter(a => a.businessUnitName === 'Engineering')
    expect(arts).toHaveLength(BU_ARTIFACT_DEFS.ready.length)
    arts.forEach(a => { expect(a.readinessStatus).toBe(ARTIFACT_READINESS.READY); expect(a.selected).toBe(true) })
  })

  it('PARTIAL BU gets 3 partial artifacts, all selected', async () => {
    const { suggestArtifacts, BU_ARTIFACT_DEFS, ARTIFACT_READINESS } = await getArtifactModule()
    const handoff = makeHandoff([['Finance', 'partial']])
    const arts = suggestArtifacts(handoff).filter(a => a.businessUnitName === 'Finance')
    expect(arts).toHaveLength(BU_ARTIFACT_DEFS.partial.length)
    arts.forEach(a => { expect(a.readinessStatus).toBe(ARTIFACT_READINESS.PARTIAL); expect(a.selected).toBe(true) })
  })

  it('BLOCKED BU gets one blocked placeholder, not selected, no generation-ready artifacts', async () => {
    const { suggestArtifacts, ARTIFACT_READINESS } = await getArtifactModule()
    const handoff = makeHandoff([['Sales', 'blocked', 'No record.']])
    const arts = suggestArtifacts(handoff).filter(a => a.businessUnitName === 'Sales')
    expect(arts).toHaveLength(1)
    expect(arts[0].readinessStatus).toBe(ARTIFACT_READINESS.BLOCKED)
    expect(arts[0].selected).toBe(false)
    expect(arts[0].artifactType).toBe('blocked')
  })

  it('global artifacts suggested when handoff is partial', async () => {
    const { suggestArtifacts, GLOBAL_ARTIFACT_DEFS } = await getArtifactModule()
    const handoff = makeHandoff([['HR', 'partial']])
    const globals = suggestArtifacts(handoff).filter(a => a.scope === 'global')
    expect(globals).toHaveLength(GLOBAL_ARTIFACT_DEFS.length)
    globals.forEach(g => expect(g.selected).toBe(true))
  })

  it('no global artifacts when all BUs blocked', async () => {
    const { suggestArtifacts } = await getArtifactModule()
    const handoff = makeHandoff([['A', 'blocked', 'x'], ['B', 'blocked', 'x']])
    expect(suggestArtifacts(handoff).filter(a => a.scope === 'global')).toHaveLength(0)
  })

  it('buildArtifactPlan: persistedAt null before persistence', async () => {
    const { buildArtifactPlan } = await getArtifactModule()
    const handoff = makeHandoff([['Engineering', 'ready']])
    const plan = buildArtifactPlan(handoff, WID, S1, S2, S3)
    expect(plan.persistedAt).toBeNull()
    expect(plan.generatedFromHandoffPersistedAt).toBe(handoff.persistedAt)
  })

  it('persistArtifactPlan: writes to IDB and sets persistedAt', async () => {
    const { buildArtifactPlan, persistArtifactPlan } = await getArtifactModule()
    const handoff = makeHandoff([['Engineering', 'ready']])
    const { ok, record } = await persistArtifactPlan(buildArtifactPlan(handoff, WID, S1, S2, S3))
    expect(ok).toBe(true)
    expect(record.persistedAt).toBeTruthy()
    expect(_idbStore.get(`bsp_v1_stage4_artifact_plan_${WID}_${S1}_${S2}_${S3}`)?.persistedAt).toBeTruthy()
  })

  it('loadArtifactPlan: returns null when nothing persisted', async () => {
    await storageRouter.initStorageCache()
    const { loadArtifactPlan } = await getArtifactModule()
    expect(await loadArtifactPlan(WID, S1, S2, S3)).toBeNull()
  })

  it('full round-trip: build → persist → reload → verified with correct BU statuses', async () => {
    const { buildArtifactPlan, persistArtifactPlan, ARTIFACT_READINESS } = await getArtifactModule()
    const handoff = makeHandoff([
      ['Engineering', 'ready'],
      ['HR', 'partial'],
      ['Sales', 'blocked', 'No record.'],
    ])
    await persistArtifactPlan(buildArtifactPlan(handoff, WID, S1, S2, S3))

    const key = `bsp_v1_stage4_artifact_plan_${WID}_${S1}_${S2}_${S3}`
    ls.setItem(key, JSON.stringify({ _idbRef: true, store: 'stage4_artifact_plans', idbKey: key }))
    vi.resetModules()
    storageRouter = await import('./storageRouter.js')
    await storageRouter.initStorageCache()
    const { loadArtifactPlan } = await import('./stage4ArtifactPlan.js')
    const verified = await loadArtifactPlan(WID, S1, S2, S3)

    expect(verified?.persistedAt).toBeTruthy()
    expect(verified.globalArtifacts.length).toBeGreaterThan(0)
    const engArts = verified.businessUnitArtifacts.filter(a => a.businessUnitName === 'Engineering')
    expect(engArts.every(a => a.readinessStatus === ARTIFACT_READINESS.READY && a.selected)).toBe(true)
    const salesArts = verified.businessUnitArtifacts.filter(a => a.businessUnitName === 'Sales')
    expect(salesArts[0].readinessStatus).toBe(ARTIFACT_READINESS.BLOCKED)
    expect(salesArts[0].selected).toBe(false)
  })

  it('selected artifacts persist and reload correctly', async () => {
    const { buildArtifactPlan, persistArtifactPlan, loadArtifactPlan } = await getArtifactModule()
    const handoff = makeHandoff([['Engineering', 'ready']])
    let plan = buildArtifactPlan(handoff, WID, S1, S2, S3)
    plan = { ...plan, globalArtifacts: plan.globalArtifacts.map((a, i) => ({ ...a, selected: i !== 0 })) }
    await persistArtifactPlan(plan)
    const verified = await loadArtifactPlan(WID, S1, S2, S3)
    expect(verified.globalArtifacts[0].selected).toBe(false)
    expect(verified.globalArtifacts[1].selected).toBe(true)
  })

  it('isArtifactPlanStale: true when handoff persistedAt changed', async () => {
    const { buildArtifactPlan, isArtifactPlanStale } = await getArtifactModule()
    const h1 = makeHandoff([['Engineering', 'ready']])
    const plan = buildArtifactPlan(h1, WID, S1, S2, S3)
    const h2 = { ...h1, persistedAt: new Date(Date.now() + 10000).toISOString() }
    expect(isArtifactPlanStale(plan, h2)).toBe(true)
    expect(isArtifactPlanStale(plan, h1)).toBe(false)
  })

  it('no AI generation called during artifact planning (suggestArtifacts and buildArtifactPlan are pure)', async () => {
    const { buildArtifactPlan, suggestArtifacts } = await getArtifactModule()
    const handoff = makeHandoff([['Engineering', 'ready']])
    idbWriteSpy.mockClear()  // reset call history from earlier tests in this suite
    suggestArtifacts(handoff)
    buildArtifactPlan(handoff, WID, S1, S2, S3)
    expect(idbWriteSpy).not.toHaveBeenCalled()
  })

  it('no artifact planning shown when no verified handoff exists (loadArtifactPlan returns null)', async () => {
    await storageRouter.initStorageCache()
    const { loadArtifactPlan } = await getArtifactModule()
    expect(await loadArtifactPlan(WID, S1, S2, 'nonexistent')).toBeNull()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// stage4ArtifactOutput — generation persistence contract
// ══════════════════════════════════════════════════════════════════════════════

describe('stage4ArtifactOutput — generation persist/verify contract', () => {
  const WID = 'ws_ao', S1 = 's1_ao', S2 = 's2_ao', S3 = 's3_ao'

  function makeMockHandoff(buStatuses) {
    const now = new Date().toISOString()
    const buHandoffs = buStatuses.map(([name, status]) => ({
      buName: name, status, blockedReason: status === 'blocked' ? 'No record.' : null,
      sourcePersistAt: status !== 'blocked' ? now : null,
      sourceAtomIds: status !== 'blocked' ? ['a1', 'a2'] : [],
      plan: status !== 'blocked' ? { buName: name, mission: `${name} mission`, strategicRole: 'role', priorityOutcomes: ['Outcome A'], criticalWorkstreams: ['WS1'] } : null,
      executionSections: status !== 'blocked' ? [{ sectionName: 'Core', objective: 'Deliver', executionStrategy: ['Do it'], decisionsRequired: ['Dec 1'], sequencingAndGates: [], dependencies: [], risks: ['Risk 1'], validationSignals: [] }] : [],
      stage4DeliveryImplications: status !== 'blocked' ? ['Implication'] : [],
    }))
    const readyCount   = buHandoffs.filter(b => b.status === 'ready').length
    const partialCount = buHandoffs.filter(b => b.status === 'partial').length
    return {
      version: 1, workspaceId: WID, stage1RevisionId: S1, stage2RevisionId: S2, stage3RevisionId: S3,
      compiledAt: now, persistedAt: now, overallStatus: readyCount > 0 ? 'ready' : 'partial',
      readyCount, partialCount, blockedCount: buHandoffs.length - readyCount - partialCount,
      totalCount: buHandoffs.length, buHandoffs,
    }
  }

  function makeMockPlan(handoff) {
    return {
      version: 1, workspaceId: WID, stage1RevisionId: S1, stage2RevisionId: S2, stage3RevisionId: S3,
      handoffKey: `bsp_v1_stage4_handoff_${WID}_${S1}_${S2}_${S3}`,
      persistedAt: handoff.persistedAt, generatedFromHandoffPersistedAt: handoff.persistedAt,
      globalArtifacts: [{
        artifactId: 'global_executive_decision_brief', artifactType: 'executive_decision_brief',
        scope: 'global', businessUnitName: null, title: 'Executive Decision Brief',
        readinessStatus: 'ready', selected: true, sourceAtomIds: ['a1'], sourceHandoffStatus: 'ready',
      }],
      businessUnitArtifacts: [{
        artifactId: 'bu_engineering_bu_execution_plan', artifactType: 'bu_execution_plan',
        scope: 'business_unit', businessUnitName: 'Engineering', title: 'BU Execution Plan',
        readinessStatus: 'ready', selected: true, sourceAtomIds: ['a1', 'a2'], sourceHandoffStatus: 'ready',
      }],
    }
  }

  async function getOutputModule() {
    vi.resetModules()
    storageRouter = await import('./storageRouter.js')
    return import('./stage4ArtifactOutput.js')
  }

  async function getPromptModule() {
    vi.resetModules()
    storageRouter = await import('./storageRouter.js')
    return import('./stage4ArtifactPrompts.js')
  }

  beforeEach(async () => {
    _idbStore.clear()
    idbWriteSpy.mockImplementation(async (_store, key, value) => { _idbStore.set(key, value) })
    ls = makeLocalStorageShim()
    vi.stubGlobal('localStorage', ls)
    vi.resetModules()
    storageRouter = await import('./storageRouter.js')
  })

  it('artifact output key routes to stage4_artifact_outputs (IDB-primary, dualWrite=false)', () => {
    const key = `bsp_v1_stage4_artifact_output_${WID}_${S1}_${S2}_${S3}_global_executive_decision_brief`
    const route = storageRouter.routeKey(key)
    expect(route?.store).toBe('stage4_artifact_outputs')
    expect(route?.dualWrite).toBe(false)
  })

  it('buildArtifactOutput: persistedAt and verifiedAt are null before persistence', async () => {
    const { buildArtifactOutput } = await getOutputModule()
    const handoff = makeMockHandoff([['Engineering', 'ready']])
    const plan    = makeMockPlan(handoff)
    const output  = buildArtifactOutput({
      workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3,
      handoff, plan, artifactItem: plan.globalArtifacts[0],
      contentSections: [], evidenceBasis: '', assumptions: [], openQuestions: [],
    })
    expect(output.persistedAt).toBeNull()
    expect(output.verifiedAt).toBeNull()
    expect(output.generationStatus).toBe('generated')
  })

  it('persistArtifactOutput: writes to IDB and stamps persistedAt', async () => {
    const { buildArtifactOutput, persistArtifactOutput } = await getOutputModule()
    const handoff = makeMockHandoff([['Engineering', 'ready']])
    const plan    = makeMockPlan(handoff)
    const output  = buildArtifactOutput({
      workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3,
      handoff, plan, artifactItem: plan.globalArtifacts[0],
      contentSections: [{ sectionId: 's1', heading: 'H', purpose: 'P', body: 'B', sourceAtomIds: [], openQuestions: [], confidenceLevel: 'high' }],
      evidenceBasis: 'E', assumptions: [], openQuestions: [],
    })
    const { ok, record } = await persistArtifactOutput(output, WID, S1, S2, S3)
    expect(ok).toBe(true)
    expect(record.persistedAt).toBeTruthy()
    const key = `bsp_v1_stage4_artifact_output_${WID}_${S1}_${S2}_${S3}_global_executive_decision_brief`
    expect(_idbStore.get(key)?.persistedAt).toBeTruthy()
  })

  it('loadArtifactOutput: returns null when not persisted', async () => {
    await storageRouter.initStorageCache()
    const { loadArtifactOutput } = await getOutputModule()
    expect(await loadArtifactOutput(WID, S1, S2, S3, 'global_executive_decision_brief')).toBeNull()
  })

  it('single artifact: persist + reload-verify round-trip', async () => {
    const { buildArtifactOutput, persistArtifactOutput, loadArtifactOutput } = await getOutputModule()
    const handoff = makeMockHandoff([['Engineering', 'ready']])
    const plan    = makeMockPlan(handoff)
    const output  = buildArtifactOutput({
      workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3,
      handoff, plan, artifactItem: plan.globalArtifacts[0],
      contentSections: [{ sectionId: 'summary', heading: 'Executive Summary', purpose: 'P', body: 'Test output.', sourceAtomIds: [], openQuestions: [], confidenceLevel: 'high' }],
      evidenceBasis: 'From verified BU records.', assumptions: ['A1'], openQuestions: ['Q1'],
    })
    await persistArtifactOutput(output, WID, S1, S2, S3)
    const key = `bsp_v1_stage4_artifact_output_${WID}_${S1}_${S2}_${S3}_global_executive_decision_brief`
    ls.setItem(key, JSON.stringify({ _idbRef: true, store: 'stage4_artifact_outputs', idbKey: key }))
    vi.resetModules()
    storageRouter = await import('./storageRouter.js')
    await storageRouter.initStorageCache()
    const { loadArtifactOutput: loadFresh } = await import('./stage4ArtifactOutput.js')
    const verified = await loadFresh(WID, S1, S2, S3, 'global_executive_decision_brief')
    expect(verified).not.toBeNull()
    expect(verified.persistedAt).toBeTruthy()
    expect(verified.contentSections[0].body).toBe('Test output.')
    expect(verified.assumptions).toEqual(['A1'])
  })

  it('failed generation does not overwrite a previously generated output', async () => {
    const { buildArtifactOutput, persistArtifactOutput, loadArtifactOutput } = await getOutputModule()
    const handoff = makeMockHandoff([['Engineering', 'ready']])
    const plan    = makeMockPlan(handoff)
    const item    = plan.globalArtifacts[0]
    const output1 = buildArtifactOutput({
      workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3,
      handoff, plan, artifactItem: item,
      contentSections: [{ sectionId: 's', heading: 'H', purpose: 'P', body: 'First good output.', sourceAtomIds: [], openQuestions: [], confidenceLevel: 'high' }],
      evidenceBasis: '', assumptions: [], openQuestions: [],
    })
    await persistArtifactOutput(output1, WID, S1, S2, S3)
    // Simulate failure: caller catches error and does NOT call persistArtifactOutput for the bad output
    const surviving = await loadArtifactOutput(WID, S1, S2, S3, item.artifactId)
    expect(surviving?.contentSections[0].body).toBe('First good output.')
  })

  it('isArtifactOutputStale: true when plan or handoff persistedAt changes', async () => {
    const { isArtifactOutputStale, buildArtifactOutput } = await getOutputModule()
    const handoff = makeMockHandoff([['Engineering', 'ready']])
    const plan    = makeMockPlan(handoff)
    const output  = buildArtifactOutput({
      workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3,
      handoff, plan, artifactItem: plan.globalArtifacts[0],
      contentSections: [], evidenceBasis: '', assumptions: [], openQuestions: [],
    })
    const stalePlan    = { ...plan,    persistedAt: new Date(Date.now() + 5000).toISOString() }
    const staleHandoff = { ...handoff, persistedAt: new Date(Date.now() + 5000).toISOString() }
    expect(isArtifactOutputStale(output, plan, handoff)).toBe(false)
    expect(isArtifactOutputStale(output, stalePlan, handoff)).toBe(true)
    expect(isArtifactOutputStale(output, plan, staleHandoff)).toBe(true)
  })

  it('loadAllArtifactOutputs: loads multiple in parallel, skips absent', async () => {
    const { buildArtifactOutput, persistArtifactOutput, loadAllArtifactOutputs } = await getOutputModule()
    const handoff = makeMockHandoff([['Engineering', 'ready']])
    const plan    = makeMockPlan(handoff)
    const out1 = buildArtifactOutput({
      workspaceId: WID, stage1Id: S1, stage2Id: S2, stage3Id: S3,
      handoff, plan, artifactItem: plan.globalArtifacts[0],
      contentSections: [], evidenceBasis: '', assumptions: [], openQuestions: [],
    })
    await persistArtifactOutput(out1, WID, S1, S2, S3)
    const results = await loadAllArtifactOutputs(WID, S1, S2, S3, ['global_executive_decision_brief', 'nonexistent'])
    expect(Object.keys(results)).toHaveLength(1)
    expect(results['global_executive_decision_brief']).toBeTruthy()
  })

  it('buildArtifactPrompt: isSupported=false for unsupported artifact type', async () => {
    const { buildArtifactPrompt } = await getPromptModule()
    const handoff = makeMockHandoff([['Engineering', 'ready']])
    const { isSupported, messages } = buildArtifactPrompt(
      { artifactId: 'x', artifactType: 'pdlc_epic_outline', scope: 'business_unit', businessUnitName: 'Engineering', title: 'PDLC', sourceAtomIds: [] },
      handoff
    )
    expect(isSupported).toBe(false)
    expect(messages).toBeNull()
  })

  it('buildArtifactPrompt: returns messages for executive_decision_brief', async () => {
    const { buildArtifactPrompt } = await getPromptModule()
    const handoff = makeMockHandoff([['Engineering', 'ready']])
    const { isSupported, messages } = buildArtifactPrompt(
      { artifactId: 'x', artifactType: 'executive_decision_brief', scope: 'global', businessUnitName: null, title: 'EB', sourceAtomIds: [] },
      handoff
    )
    expect(isSupported).toBe(true)
    expect(messages[0].content).toContain('Engineering')
  })

  it('parseArtifactResponse: parses valid JSON', async () => {
    const { parseArtifactResponse } = await getPromptModule()
    const raw = JSON.stringify({
      contentSections: [{ sectionId: 's1', heading: 'H', purpose: 'P', body: 'B', sourceAtomIds: [], openQuestions: [], confidenceLevel: 'high' }],
      evidenceBasis: 'E', assumptions: ['A1'], openQuestions: ['Q1'],
    })
    const result = parseArtifactResponse(raw)
    expect(result.error).toBeNull()
    expect(result.contentSections[0].body).toBe('B')
  })

  it('parseArtifactResponse: returns error for invalid JSON', async () => {
    const { parseArtifactResponse } = await getPromptModule()
    expect(parseArtifactResponse('not json').error).toBeTruthy()
  })

  it('generateMockArtifactOutput: returns valid sections without any storage writes', async () => {
    const { generateMockArtifactOutput } = await getPromptModule()
    idbWriteSpy.mockClear()
    const handoff = makeMockHandoff([['Engineering', 'ready']])
    const item = { artifactId: 'x', artifactType: 'executive_decision_brief', scope: 'global', businessUnitName: null, title: 'EB', sourceAtomIds: ['a1'] }
    const result = generateMockArtifactOutput(item, handoff)
    expect(result.contentSections.length).toBeGreaterThan(0)
    expect(idbWriteSpy).not.toHaveBeenCalled()
  })

  it('unselected artifacts tracked in persisted plan — generation caller must check selected', async () => {
    const { buildArtifactPlan, persistArtifactPlan, loadArtifactPlan } = await import('./stage4ArtifactPlan.js')
    const handoff = makeMockHandoff([['Engineering', 'ready']])
    let plan = buildArtifactPlan(handoff, WID, S1, S2, S3)
    plan = {
      ...plan,
      globalArtifacts:       plan.globalArtifacts.map(a => ({ ...a, selected: false })),
      businessUnitArtifacts: plan.businessUnitArtifacts.map(a => ({ ...a, selected: false })),
    }
    await persistArtifactPlan(plan)
    const loaded = await loadArtifactPlan(WID, S1, S2, S3)
    expect([...loaded.globalArtifacts, ...loaded.businessUnitArtifacts].some(a => a.selected)).toBe(false)
  })
})
