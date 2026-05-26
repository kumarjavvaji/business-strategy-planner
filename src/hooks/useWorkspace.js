// Workspace hook — persists normalized package + raw source to localStorage.
// Storage key is namespaced away from DomainIQ's diq_v4_* keys.

import { useState, useEffect } from 'react'
import { normalizeStrategyBasisPackage } from '../utils/packageImport'

const STORAGE_KEY = 'bsp_v1_workspace'

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return { workspace: null, sourcePackage: null }
}

export function useWorkspace() {
  const [state, setState] = useState(loadFromStorage)

  // Persist on every state change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {}
  }, [state])

  // Validate, normalize, and persist a raw package object.
  // Returns { error: string|null }.
  function importPackage(raw) {
    const result = normalizeStrategyBasisPackage(raw)
    if (result.error) return { error: result.error }
    setState({ workspace: result.workspace, sourcePackage: result.sourcePackage })
    return { error: null }
  }

  // Remove workspace from state and storage.
  function clearWorkspace() {
    setState({ workspace: null, sourcePackage: null })
    try { localStorage.removeItem(STORAGE_KEY) } catch {}
  }

  return {
    workspace:     state.workspace,
    sourcePackage: state.sourcePackage,
    importPackage,
    clearWorkspace,
  }
}
