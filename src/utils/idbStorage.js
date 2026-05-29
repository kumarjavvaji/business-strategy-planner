/**
 * Low-level IndexedDB CRUD for the Strategy Planner.
 * All exports are async. No direct DOM or React dependency.
 *
 * DB:      bsp_strategy_planner   v1
 * Stores (all keyed by their localStorage key string for cross-reference):
 *   plans                — workspace plan blobs (bsp_plan_v1_*, bsp_v1_workspace)
 *   stage2_handoffs      — handoff drafts (bsp_v1_handoff_*)
 *   stage3_bu_plans      — BU execution plan drafts (bsp_v1_stage3_bu_plan_*)
 *   stage3_coordination  — coordination drafts (bsp_v1_stage3_coordination_*)
 *   migration_audit      — log of migration events
 */

const DB_NAME    = 'bsp_strategy_planner'
const DB_VERSION = 1

export const IDB_STORES = {
  PLANS:               'plans',
  STAGE2_HANDOFFS:     'stage2_handoffs',
  STAGE3_BU_PLANS:     'stage3_bu_plans',
  STAGE3_COORDINATION: 'stage3_coordination',
  MIGRATION_AUDIT:     'migration_audit',
}

let _db          = null
let _openPromise = null

function openDB() {
  if (_db)          return Promise.resolve(_db)
  if (_openPromise) return _openPromise
  _openPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      for (const storeName of Object.values(IDB_STORES)) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName)
        }
      }
    }
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db) }
    req.onerror   = (e) => { _openPromise = null; reject(e.target.error) }
    req.onblocked = ()  => { _openPromise = null; reject(new Error('IDB open blocked by another tab')) }
  })
  return _openPromise
}

export async function idbWrite(store, key, value) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve(true)
    tx.onerror    = (e) => reject(e.target.error)
    tx.onabort    = (e) => reject(e.target.error || new Error('IDB transaction aborted'))
  })
}

export async function idbRead(store, key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = (e) => resolve(e.target.result ?? null)
    req.onerror   = (e) => reject(e.target.error)
  })
}

export async function idbReadAll(store) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(store, 'readonly')
    const results = []
    const req     = tx.objectStore(store).openCursor()
    req.onsuccess = (e) => {
      const cursor = e.target.result
      if (cursor) {
        results.push({ key: cursor.key, value: cursor.value })
        cursor.continue()
      } else {
        resolve(results)
      }
    }
    req.onerror = (e) => reject(e.target.error)
  })
}

export async function idbDelete(store, key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => resolve(true)
    tx.onerror    = (e) => reject(e.target.error)
  })
}

/**
 * Read all records from all BSP stores. Used by storageMigration.js for reporting.
 */
export async function idbReadAllStores() {
  const result = {}
  for (const store of Object.values(IDB_STORES)) {
    try {
      result[store] = await idbReadAll(store)
    } catch {
      result[store] = []
    }
  }
  return result
}
