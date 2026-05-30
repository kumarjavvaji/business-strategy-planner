/**
 * Tests for storageRouter — Stage 3 BU plan persistence contract.
 * Covers: generation → save → reload → render eligibility.
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
    PLANS:               'plans',
    STAGE2_HANDOFFS:     'stage2_handoffs',
    STAGE3_BU_PLANS:     'stage3_bu_plans',
    STAGE3_COORDINATION: 'stage3_coordination',
  },
  idbRead:    async (_store, key)        => _idbStore.get(key) ?? null,
  idbWrite:   (...args) => idbWriteSpy(...args),
  idbReadAll: async (_store) => {
    const prefix = _store === 'stage3_bu_plans' ? 'bsp_v1_stage3_bu_plan_' : ''
    return [..._idbStore.entries()]
      .filter(([k]) => !prefix || k.startsWith(prefix))
      .map(([key, value]) => ({ key, value }))
  },
}))

// ── Test helpers ───────────────────────────────────────────────────────────────
function stage3Key(workspaceId, stage1Id, stage2Id, buName) {
  const safe = buName.toLowerCase().replace(/[^a-z0-9]/g, '_')
  return `bsp_v1_stage3_bu_plan_${workspaceId}_${stage1Id}_${stage2Id}_${safe}`
}

function makeDraft(buName, overrides = {}) {
  return {
    version: 1,
    businessUnitName: buName,
    buName,
    source: 'ai',
    status: 'draft_generated',
    lifecycle: { status: 'draft_generated' },
    plan: { buName, executionSections: [{ sectionName: 'Strategy', objective: 'Win' }] },
    executionAtoms: [{ id: `stage3:${buName}:s1:objective`, status: 'complete', parsedValue: 'Win' }],
    persistedAt: new Date().toISOString(),
    lastSavedAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────
describe('storageRouter — Stage 3 BU plan persistence', () => {
  let ls
  let storageRouter

  beforeEach(async () => {
    // Reset IDB store
    _idbStore.clear()

    // Fresh LS shim for each test
    ls = makeLocalStorageShim()
    vi.stubGlobal('localStorage', ls)

    // Re-import storageRouter with a clean module state
    vi.resetModules()
    storageRouter = await import('./storageRouter.js')
  })

  // ── Key routing ─────────────────────────────────────────────────────────────

  it('routes stage3 BU plan key to IDB store', () => {
    const key = 'bsp_v1_stage3_bu_plan_ws1_s1_s2_product_management'
    const route = storageRouter.routeKey(key)
    expect(route).not.toBeNull()
    expect(route.store).toBe('stage3_bu_plans')
    expect(route.dualWrite).toBe(false)
  })

  it('routes unrecognised key to null (LS-only)', () => {
    expect(storageRouter.routeKey('some_random_key')).toBeNull()
    expect(storageRouter.routeKey(null)).toBeNull()
    expect(storageRouter.routeKey('')).toBeNull()
  })

  // ── Write → IDB-primary pointer ─────────────────────────────────────────────

  it('writeArtifact writes to IDB and puts a pointer in LS', async () => {
    const key = stage3Key('ws1', 's1', 's2', 'Product Management')
    const draft = makeDraft('Product Management')

    const ok = await storageRouter.writeArtifact(key, draft)

    expect(ok).toBe(true)
    // IDB has the real value
    const { idbRead } = await import('./idbStorage.js')
    const idbVal = await idbRead('stage3_bu_plans', key)
    expect(idbVal?.plan?.buName).toBe('Product Management')

    // LS has a compact pointer, not the full blob
    const lsRaw = ls.getItem(key)
    const lsParsed = JSON.parse(lsRaw)
    expect(lsParsed._idbRef).toBe(true)
    expect(lsParsed.store).toBe('stage3_bu_plans')
  })

  // ── Read from cache after write ──────────────────────────────────────────────

  it('readCached returns the draft synchronously after writeArtifact', async () => {
    const key = stage3Key('ws1', 's1', 's2', 'Engineering')
    const draft = makeDraft('Engineering')

    await storageRouter.writeArtifact(key, draft)

    const cached = storageRouter.readCached(key)
    expect(cached?.plan?.buName).toBe('Engineering')
  })

  // ── Reload simulation: readArtifactAsync after storageReady ─────────────────

  it('readArtifactAsync returns draft after initStorageCache loads IDB', async () => {
    const key = stage3Key('ws1', 's1', 's2', 'Finance')
    const draft = makeDraft('Finance')

    // Pre-load IDB directly (simulates content saved in a prior session)
    _idbStore.set(key, draft)
    // LS only has the pointer (as it would after a write)
    ls.setItem(key, JSON.stringify({ _idbRef: true, store: 'stage3_bu_plans', idbKey: key }))

    // Initialise cache — simulates app startup after reload
    await storageRouter.initStorageCache()

    const loaded = await storageRouter.readArtifactAsync(key)
    expect(loaded?.plan?.buName).toBe('Finance')
    expect(loaded?.version).toBe(1)
  })

  // ── Reload: readCached works after storageReady ──────────────────────────────

  it('readCached returns draft synchronously after cache is warm from IDB', async () => {
    const key = stage3Key('ws1', 's1', 's2', 'HR')
    const draft = makeDraft('HR')

    _idbStore.set(key, draft)
    ls.setItem(key, JSON.stringify({ _idbRef: true, store: 'stage3_bu_plans', idbKey: key }))

    await storageRouter.initStorageCache()

    // After init, synchronous read should hit the warm cache
    const cached = storageRouter.readCached(key)
    expect(cached?.buName).toBe('HR')
  })

  // ── Reload: missing IDB entry returns null ───────────────────────────────────

  it('readArtifactAsync returns null when IDB has no entry (not persisted)', async () => {
    const key = stage3Key('ws1', 's1', 's2', 'Sales')
    // LS pointer exists but IDB is empty — simulates a failed IDB write
    ls.setItem(key, JSON.stringify({ _idbRef: true, store: 'stage3_bu_plans', idbKey: key }))

    await storageRouter.initStorageCache()

    const loaded = await storageRouter.readArtifactAsync(key)
    expect(loaded).toBeNull()
  })

  // ── IDB write failure: writeArtifact returns false ───────────────────────────

  it('writeArtifact returns false when IDB write throws', async () => {
    idbWriteSpy.mockRejectedValueOnce(new Error('IDB quota exceeded'))

    const key = stage3Key('ws1', 's1', 's2', 'Operations')
    const draft = makeDraft('Operations')

    const ok = await storageRouter.writeArtifact(key, draft)
    expect(ok).toBe(false)

    // Restore normal behaviour for subsequent tests
    idbWriteSpy.mockImplementation(async (_store, key, value) => { _idbStore.set(key, value) })
  })

  // ── isIdbPointer detection ───────────────────────────────────────────────────

  it('isIdbPointer correctly identifies pointer vs real content', () => {
    expect(storageRouter.isIdbPointer({ _idbRef: true, store: 'stage3_bu_plans', idbKey: 'k' })).toBe(true)
    expect(storageRouter.isIdbPointer({ plan: { buName: 'Foo' } })).toBe(false)
    expect(storageRouter.isIdbPointer(null)).toBe(false)
    expect(storageRouter.isIdbPointer('string')).toBe(false)
  })

  // ── Round-trip: generate → persist → reload → render eligibility ─────────────

  it('full round-trip: write draft, reload cache, verify render eligibility', async () => {
    const key = stage3Key('ws_rt', 's1_rt', 's2_rt', 'Product Management')
    const draft = makeDraft('Product Management', {
      lifecycle: { status: 'draft_generated' },
      executionAtoms: [
        { id: 'stage3:Product Management:strategy:objective', status: 'complete', parsedValue: 'Deliver roadmap' },
        { id: 'stage3:Product Management:strategy:risks',     status: 'complete', parsedValue: ['Late vendor'] },
      ],
    })

    // Step 1: Generation saves to storage
    const writeOk = await storageRouter.writeArtifact(key, draft)
    expect(writeOk).toBe(true)

    // Step 2: Simulate reload — clear cache, reinitialise from IDB
    vi.resetModules()
    _idbStore.set(key, draft) // IDB still has it (persisted across reload)
    ls.setItem(key, JSON.stringify({ _idbRef: true, store: 'stage3_bu_plans', idbKey: key }))

    const freshRouter = await import('./storageRouter.js')
    await freshRouter.initStorageCache()

    // Step 3: Hydration reads succeed
    const reloaded = freshRouter.readCached(key)
    expect(reloaded).not.toBeNull()
    expect(reloaded.version).toBe(1)
    expect(reloaded.lifecycle.status).toBe('draft_generated')

    // Step 4: Render eligibility — plan content is present and valid
    const eligibleAtoms = reloaded.executionAtoms.filter(a => a.status === 'complete')
    expect(eligibleAtoms.length).toBeGreaterThan(0)
    expect(reloaded.plan?.executionSections?.length).toBeGreaterThan(0)
    expect(reloaded.persistedAt).toBeTruthy()
  })
})
