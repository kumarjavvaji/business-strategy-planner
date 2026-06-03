# Business Strategy Planner

A browser-based AI-assisted tool that takes a raw strategy document and progressively refines it into deployment-ready delivery artifacts — from high-level thesis to per-business-unit execution plans to SME-reviewable deliverables.

---

## What it does

The app walks a strategy through five sequential stages. Each stage builds on the last; the output of one stage becomes the verified source of the next.

### Stage 1 — Strategy Basis

Ingests a strategy package (JSON) and presents the core thesis, business problem, opportunity, recommended direction, key decisions, risks, and validation checkpoints. With an Anthropic API key configured, a refinement panel lets you apply targeted edits ("strengthen the compliance angle", "remove the fintech assumption") via AI — the model patches only the affected fields and leaves everything else unchanged. Every AI revision is snapshot-diffed and stored so you can step back through the history.

### Stage 2 — Business Unit Mapping

Derives which business units (BUs) are in scope and what each owns, produces, and depends on. BUs are auto-sorted by organizational layer (governance → product → delivery → sales → support) so the dependency chain reads top-to-bottom. Cross-functional dependencies and KPI ownership are surfaced at this stage. Structural changes (add/remove/merge a BU) are tracked separately from wording refinements.

### Stage 3 — Execution Planning

Generates a per-BU execution plan for every business unit identified in Stage 2. Each plan is generated as independent atomic units (atoms) so a failure in one section doesn't block the others. The panel model captures:

- **Strategic Objective** — BU-specific thesis and priority outcomes
- **Execution Sequence** — phased how-options mapped to Stage 4 deliverable types
- **Critical Decisions** — governance gates and decision timing
- **Dependencies** — cross-BU and external inputs required
- **Risks & Mitigations** — with early-warning signals and evidence needed
- **Validation Framework** — readiness checks and acceptance criteria

Plans can be accepted, rejected, or partially regenerated at the atom level. A compiled strategy quality audit runs across all panels and flags truncation, repetition, or missing source traceability before anything flows downstream.

Staleness tracking detects when upstream Stage 1/2 changes may affect generated Stage 3 content and surfaces impact-classified warnings (material stale / review recommended / unaffected).

### Stage 4 — Deliverables

Compiles a Stage 4 handoff from accepted Stage 3 source atoms, then plans and generates structured delivery artifacts. Artifact types include:

**BU-scoped:**
- BU Execution Plan
- PDLC Epic Outline
- Acceptance Criteria Draft
- Implementation Governance Checklist
- SME Review Packet

**Cross-BU / global:**
- Executive Decision Brief
- Cross-BU Dependency Map
- Risk and Control Plan
- Operating Cadence Plan
- SME Review Packet (organisation-wide)

Each artifact is generated atomically (one prompt per section child), so a failed section can be retried in isolation without re-running the whole document. Artifacts are grounded exclusively in mapped how-options from the Execution Sequence panel — unmapped tactics are excluded. Source traceability is preserved through every atom to the original Stage 3 accepted content.

**Execution-section normalization** (branch `stage4`): before any artifact is generated, the raw execution sections from Stage 3 are clustered by base-framing similarity. Near-duplicate sections collapse to one representative; unique execution constraints (ramp delays, schema complexity, Sprint 2 milestone risk, etc.) are extracted as structured deltas rather than silently discarded. Diagnostic output explains every retained, merged, or removed section.

### Stage 5 — Synthesis (planned)

Reads learning signals collected across Stages 1–4 (refinement corrections, assumption shifts, evidence gaps, failure modes, SME validation needs, etc.) and synthesises them into reusable strategy patterns, prompt improvements, and cross-stage heuristics.

---

## Architecture

```
src/
  api/
    aiClient.js              Anthropic API wrapper (streaming + mock mode)
  components/
    Stage1View.jsx           Strategy basis review + AI refinement panel
    Stage2View.jsx           Business unit mapping
    Stage3View.jsx           Per-BU execution plan generation + panel model
    Stage3PanelView.jsx      Individual panel editor (decisions, risks, validation, etc.)
    Stage4View.jsx           Handoff compiler + artifact planning + generation
    RevisionHistory.jsx      Snapshot timeline with diff viewer
    RevisionDiffViewer.jsx   Field-level diff between two revision snapshots
    LearningSignals.jsx      Stage 5 signal display
    RefinementPanel.jsx      Shared AI refinement input/output panel
  data/
    demoPackage.js           Built-in demo strategy for offline use
  hooks/
    useWorkspace.js          Central workspace state (load, import, navigate stages)
  utils/
    storageRouter.js         Routes artifacts to IndexedDB or localStorage
    idbStorage.js            IndexedDB adapter with store definitions
    stageSnapshots.js        Snapshot builder and serialiser for each stage
    stage1Prompts.js         Stage 1 AI prompt builder + response normaliser
    stage2Prompts.js         Stage 2 prompt builder (BU mapping)
    stage3Prompts.js         Stage 3 prompt builder (execution planning)
    stage3Compiler.js        Compiles per-BU atoms into a plan record
    stage3PanelModel.js      Panel model schema, lifecycle transitions, and validators
    stage3PanelLifecycle.js  Panel readiness, issue detection, staleness flags
    stage3PanelPrompts.js    Per-panel AI prompt builders
    stage3StalenessImpact.js Upstream change impact classifier (material/review/unaffected)
    stage3BuPlanKeys.js      Canonical IDB key derivation for per-BU plans
    stage3ChildUnitGeneration.js  Atomic section child generation helpers
    stage4Handoff.js         Compiles Stage 4 handoff from accepted Stage 3 atoms
    stage4ExecutionSectionNormalizer.js  Group-based dedup of raw execution sections
    stage4ArtifactPlan.js    Artifact plan builder, readiness checks, IDB persistence
    stage4ArtifactBasis.js   Compiles compact artifact basis from panel data
    stage4ArtifactSpecs.js   Artifact authoring specs (section schemas, SME lens, QA rules)
    stage4ArtifactPrompts.js Per-artifact prompt builders + child/section prompt builders
    stage4ArtifactLifecycle.js  Section/atom lifecycle state machine
    stage4ArtifactOutput.js  Assembles artifacts from completed atoms; quality audit
    stage4ReadinessNavigation.js  Deep-link targets for readiness blockers
    stage5LearningSignals.js Stage 5 signal collection and normalisation
    generationAtoms.js       Shared atom model used across generation pipelines
    generationLifecycle.js   Shared generation lifecycle utilities
    generationQueue.js       Concurrency-limited generation queue
    unitLifecycle.js         Unit lifecycle (not_started → generating → accepted/failed)
    learningSignals.js       Cross-stage signal derivation
    diffText.js              Word-level diff for revision viewer
    handoffPrompts.js        Prompt builders for cross-stage handoff messages
    storageMigration.js      IDB schema migration helpers
```

---

## Storage model

All large artifacts (plans, handoffs, generated outputs) go to IndexedDB so they survive page refreshes and don't saturate the 5 MB localStorage quota. Small keys and IDB pointer references stay in localStorage for fast synchronous startup reads.

| IDB store | Contents |
|---|---|
| `plans` | Workspace record, Stage 1/2 plan blobs |
| `stage2_handoffs` | Stage 2 BU mapping handoffs |
| `stage3_bu_plans` | Per-BU execution plan atom records |
| `stage3_coordination` | Cross-BU coordination records |
| `stage4_handoffs` | Compiled Stage 4 handoff records |
| `stage4_artifact_plans` | Artifact plan records |
| `stage4_artifact_outputs` | Generated artifact section/atom outputs |
| `stage5_learning_signals` | Collected learning signals |

---

## Running the app

```bash
npm install
npm run dev          # start dev server (Vite HMR)
npm test             # run Vitest test suite
npm run test:watch   # watch mode
npm run build        # production build
npm run preview      # serve production build locally
```

### API key

Set `VITE_ANTHROPIC_API_KEY` in a `.env.local` file to enable real AI generation:

```
VITE_ANTHROPIC_API_KEY=sk-ant-...
```

Without a key the app runs in mock mode — all generation returns clearly-labelled placeholder output so the full UI and pipeline can be exercised without an API key.

---

## Branch: `stage4`

Active development branch. Contains the Stage 4 handoff compiler, artifact planning pipeline, atomic generation, and execution-section normalization work. Notable additions on this branch:

- **Execution-section normalizer** (`stage4ExecutionSectionNormalizer.js`) — group-based algorithm that clusters near-duplicate execution sections by base-framing similarity, keeps the strongest representative, extracts unique execution deltas (ramp delays, schema complexity, Sprint 2 milestone risk, etc.) as structured records, and removes sections that add no distinct execution value. Diagnostic output (issueType + reason + remediation) explains every section's disposition.
- **Artifact basis compiler** (`stage4ArtifactBasis.js`) — builds a compact, artifact-specific source packet from accepted Stage 3 panel data. Only how-options explicitly mapped to a given artifact type are included; unmapped tactics are excluded and logged.
- **Atomic artifact generation** — each artifact section is generated as individual child atoms. A failure in one atom is isolated; siblings and other sections are unaffected. Failed atoms can be retried at the smallest unit without re-running the document.
- **Artifact specs** (`stage4ArtifactSpecs.js`) — declarative authoring specs defining section schemas, SME lens, quality checks, and acceptance criteria for each artifact type.
- **Stage 4 quality audit** — post-generation audit checks for truncation markers, repeated paragraph blocks, copied Stage 3 prose, missing source mappings, and generic filler.

---

## Tests

```bash
npm test
```

The test suite covers:

- Stage 3 panel lifecycle (readiness, issues, staleness, D22 mapping inconsistency)
- Stage 3 staleness impact classification
- Stage 3 compiler and child-unit generation
- Unit lifecycle state machine
- Storage router (IDB routing, dual-write, pointer resolution)
- Stage 4 handoff staleness detection
- Stage 4 artifact pipeline (decomposition, atom identity, persistence, retry isolation, truncation isolation)
- Stage 4 artifact lifecycle and output assembly
- Stage 4 active-deliverable filtering
- Stage 4 readiness navigation
- Stage 4 execution-section normalizer (grouping, delta extraction, source ref preservation, diagnostic taxonomy)
- Stage 5 learning signal collection

All 602 tests pass on the `stage4` branch.
