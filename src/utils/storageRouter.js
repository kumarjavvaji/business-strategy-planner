/**
 * Storage router: routes large artifacts to IndexedDB, keeps small keys in localStorage.
 * Maintains an in-memory cache so synchronous callers can read IDB-stored data.
 *
 * Key routing:
 *   bsp_plan_v1_*                → IDB: plans              dual-write (also LS)
 *   bsp_v1_workspace             → IDB: plans              dual-write (also LS)
 *   bsp_v1_handoff_*             → IDB: stage2_handoffs    IDB-primary (LS pointer)
 *   bsp_v1_stage3_bu_plan_*      → IDB: stage3_bu_plans    IDB-primary (LS pointer)
 *   bsp_v1_stage3_coord*         → IDB: stage3_coordination IDB-primary (LS pointer)
 *   everything else              → LS only
 *
 * Pointer shape stored in localStorage for IDB-primary keys:
 *   { "_idbRef": true, "store": "<storeName>", "idbKey": "<lsKey>" }
 *
 * Usage:
 *   import { initStorageCache, storageReady, readCached, readArtifactAsync, writeArtifact } from './storageRouter'
 *
 *   // App startup (non-blocking):
 *   initStorageCache()
 *
 *   // Synchronous read (after cache init):
 *   const value = readCached(key)
 *
 *   // Async read (awaits cache init if needed):
 *   const value = await readArtifactAsync(key)
 *
 *   // Async write (IDB + LS pointer/value):
 *   const ok = await writeArtifact(key, value)
 */

import { IDB_STORES, idbRead, idbWrite, idbReadAll } from './idbStorage'

// ── Key routing table ──────────────────────────────────────────────────────────

// dualWrite=true  → write to IDB AND keep full JSON value in LS (for sync startup reads)
// dualWrite=false → write to IDB only; store a small pointer in LS
const ROUTES = [
  { prefix: 'bsp_plan_v1_',              store: IDB_STORES.PLANS,               dualWrite: true  },
  { key:    'bsp_v1_workspace',           store: IDB_STORES.PLANS,               dualWrite: true  },
  { prefix: 'bsp_v1_handoff_',            store: IDB_STORES.STAGE2_HANDOFFS,     dualWrite: false },
  { prefix: 'bsp_v1_stage3_bu_plan_',     store: IDB_STORES.STAGE3_BU_PLANS,     dualWrite: false },
  { prefix: 'bsp_v1_stage3_coord',        store: IDB_STORES.STAGE3_COORDINATION, dualWrite: false },
]

const IDB_POINTER_MARKER = '_idbRef'

/**
 * Returns the IDB route for a localStorage key, or null if LS-only.
 */
export function routeKey(lsKey) {
  if (!lsKey) return null
  for (const r of ROUTES) {
    if (r.key    && r.key === lsKey)              return { store: r.store, dualWrite: r.dualWrite }
    if (r.prefix && lsKey.startsWith(r.prefix))   return { store: r.store, dualWrite: r.dualWrite }
  }
  return null
}

function makePointer(store, idbKey) {
  return { [IDB_POINTER_MARKER]: true, store, idbKey }
}

/**
 * Returns true if a parsed JSON value is an IDB pointer (not real content).
 */
export function isIdbPointer(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value[IDB_POINTER_MARKER] === true
  )
}

// ── In-memory cache ────────────────────────────────────────────────────────────

const _cache      = new Map()   // lsKey → parsed value
let   _initPromise = null       // singleton — runs once

// ── Public read API ────────────────────────────────────────────────────────────

/**
 * Synchronous read. Returns from in-memory cache first, then raw localStorage.
 * If the LS value is an IDB pointer and the cache isn't warm yet, returns null.
 * Use readArtifactAsync() when you need a guarantee.
 */
export function readCached(key) {
  if (!key) return null
  if (_cache.has(key)) return _cache.get(key)

  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (isIdbPointer(parsed)) return null  // cache not warm; caller must use async path
    _cache.set(key, parsed)
    return parsed
  } catch {
    return null
  }
}

/**
 * Async read. Waits for the cache to initialise, then returns from cache
 * or falls back to a direct IDB read.
 */
export async function readArtifactAsync(key) {
  if (!key) return null
  await storageReady()

  if (_cache.has(key)) return _cache.get(key)

  // Not in cache — check LS
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(key)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (!isIdbPointer(parsed)) {
          _cache.set(key, parsed)
          return parsed
        }
        // Is a pointer — read directly from IDB
        const route = routeKey(key)
        if (route) {
          const val = await idbRead(route.store, key)
          if (val != null) { _cache.set(key, val); return val }
        }
      }
    }
  } catch { /* fall through */ }

  return null
}

// ── Public write API ───────────────────────────────────────────────────────────

/**
 * Async write. Routes routed keys to IDB (with LS pointer for IDB-primary keys,
 * or LS full-copy for dual-write keys). Unrouted keys go to LS only.
 * Always updates the in-memory cache on success.
 * Returns true on success, false on failure.
 */
export async function writeArtifact(key, value) {
  if (!key) return false

  _cache.set(key, value)

  const route = routeKey(key)

  if (!route) {
    // LS-only path (e.g. bsp_plan_index_v1, bsp_v1_stage2_handoff_focus)
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(value))
      }
      return true
    } catch {
      return false
    }
  }

  // Write to IDB
  try {
    await idbWrite(route.store, key, value)
  } catch (e) {
    console.error('[storageRouter] IDB write failed for', key, e)
    // Attempt LS fallback so data isn't lost
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(value))
      }
    } catch { /* quota exceeded */ }
    return false
  }

  if (route.dualWrite) {
    // Keep full value in LS too (needed for synchronous startup reads in useWorkspace)
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(value))
      }
    } catch {
      // LS quota exceeded — replace with pointer; IDB still has the data
      try {
        localStorage.setItem(key, JSON.stringify(makePointer(route.store, key)))
      } catch { /* LS completely full */ }
    }
  } else {
    // IDB-primary — write compact pointer to LS
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(makePointer(route.store, key)))
      }
    } catch { /* LS completely full; IDB has it */ }
  }

  return true
}

// ── Init ───────────────────────────────────────────────────────────────────────

/**
 * Initialise the in-memory cache from IndexedDB, then migrate any large LS items
 * that should be in IDB but aren't yet.
 * Safe to call multiple times — runs exactly once.
 * Non-blocking: does not affect the synchronous render path.
 */
export function initStorageCache() {
  if (_initPromise) return _initPromise
  _initPromise = _doInit()
  return _initPromise
}

/**
 * Returns the init promise. Await this before performing reads that need
 * IDB-stored data (e.g. Stage 3 hydration effects).
 */
export function storageReady() {
  return initStorageCache()
}

async function _doInit() {
  // ── Step 1: load all IDB records into cache ─────────────────────────────────
  const storesToLoad = [
    IDB_STORES.PLANS,
    IDB_STORES.STAGE2_HANDOFFS,
    IDB_STORES.STAGE3_BU_PLANS,
    IDB_STORES.STAGE3_COORDINATION,
  ]
  for (const store of storesToLoad) {
    try {
      const records = await idbReadAll(store)
      for (const { key, value } of records) {
        // IDB value wins — it was intentionally routed there
        _cache.set(key, value)
      }
    } catch (e) {
      console.warn('[storageRouter] IDB read-all failed for store:', store, e)
    }
  }

  // ── Step 2: migrate LS items that belong in IDB but haven't been moved yet ──
  const toMigrate = []
  try {
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (!key) continue
        const route = routeKey(key)
        if (!route) continue                  // not a routed key
        if (_cache.has(key)) continue         // already loaded from IDB
        const raw = localStorage.getItem(key)
        if (!raw) continue
        let parsed
        try { parsed = JSON.parse(raw) } catch { continue }
        if (isIdbPointer(parsed)) continue    // already migrated; just not in IDB yet
        toMigrate.push({ key, store: route.store, dualWrite: route.dualWrite, value: parsed, sizeBytes: raw.length * 2 })
      }
    }
  } catch (e) {
    console.warn('[storageRouter] LS scan during init failed:', e)
  }

  for (const { key, store, dualWrite, value, sizeBytes } of toMigrate) {
    try {
      await idbWrite(store, key, value)
      _cache.set(key, value)
      if (!dualWrite) {
        // Replace large LS value with compact pointer
        try {
          localStorage.setItem(key, JSON.stringify(makePointer(store, key)))
        } catch { /* quota exceeded; IDB has it */ }
      }
      console.info(`[storageRouter] migrated ${key} → IDB ${store} (~${Math.round(sizeBytes / 1024)}KB freed from LS)`)
    } catch (e) {
      console.warn('[storageRouter] migration failed for', key, e)
    }
  }
}

// ── Diagnostics ────────────────────────────────────────────────────────────────

/**
 * Returns a snapshot of current storage state. Non-destructive.
 */
export function getStorageDiagnostics() {
  const idbCachedKeys = [..._cache.keys()]

  let lsTotalBytes = 0
  const lsBspKeys     = []
  const lsPointerKeys = []
  const lsAllKeys     = []

  try {
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (!key) continue
        const raw = localStorage.getItem(key) || ''
        lsTotalBytes += (key.length + raw.length) * 2   // UTF-16 estimate
        lsAllKeys.push(key)
        if (key.startsWith('bsp_')) {
          lsBspKeys.push(key)
          try {
            const parsed = JSON.parse(raw)
            if (isIdbPointer(parsed)) lsPointerKeys.push(key)
          } catch { /* unparseable */ }
        }
      }
    }
  } catch { /* permission error */ }

  return {
    initialized:    _initPromise !== null,
    idbCacheSize:   _cache.size,
    idbCachedKeys,
    lsApproxBytes:  lsTotalBytes,
    lsEstimatedQuotaPct: Math.round(lsTotalBytes / (5 * 1024 * 1024) * 100),
    lsTotalKeys:    lsAllKeys.length,
    lsBspKeys,
    lsPointerKeys,
  }
}
