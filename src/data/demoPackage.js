// Demo Strategy Basis Package — Finlytica / Banking-Domain LLM
// Used when no package has been imported yet.
// Mirrors the v1.0 export schema from DomainIQ.

export const DEMO_STRATEGY_BASIS_PACKAGE = {
  packageType:      'domainiq_strategy_basis_package',
  packageVersion:   '1.0',
  exportedAt:       '2026-05-25T13:40:00.000Z',
  sourceApp:        'DomainIQ',
  sourceAppVersion: 'v4',

  sourceSession: {
    sessionId:    'demo_finlytica_001',
    sessionName:  'Finlytica',
    analysisType: 'Product strategy',
    company:      'Finlytica',
    industry:     '',
    domain:       '',
    workflow:     'How does Finlytica\'s managed-services model scale, and what does the platform transition look like?',
  },

  selectedArtifact: {
    artifactId:            'art_demo_001',
    artifactType:          'selective investment',
    artifactTitle:         'Banking-Domain LLM as Regulatory Moat for Board Narrative',
    artifactVersionId:     'art_demo_001_v2',
    artifactVersionNumber: 2,
    artifactCreatedAt:     '2026-05-25T13:29:08.030Z',
    versionCreatedAt:      '2026-05-25T13:38:55.070Z',
    artifactContent:       '',   // flattened text omitted in demo — use artifactData
    artifactSummary:       'Staged Investment thesis for CFO narrative differentiation before commoditisation closes.',
    artifactData: {
      artifactTitle:   'Banking-Domain LLM as Regulatory Moat for Board Narrative',
      subtitle:        'Staged Investment thesis for CFO narrative differentiation before commoditisation closes.',
      personaSummary:  'CFO and board evaluating selective LLM investment to defend Finlytica\'s board-reporting value proposition.',
      sections: [
        {
          heading: 'STRATEGIC IMPERATIVE',
          body: 'General-purpose LLMs — Copilot, Gemini, GPT-4o — are entering community bank workflows and will commoditise narrative generation within 18–24 months if Finlytica does not establish a defensible differentiation layer. Board narrative output is Finlytica\'s highest-retention value driver for CFO buyers whose workflows remain spreadsheet-dependent and board-reporting manual. The strategic question is not whether to invest in LLM capability, but whether Finlytica can build a banking-domain narrative layer — grounded in call report structures, regulatory language, and examiner conventions — fast enough to convert what is currently a feature into a regulatory moat before general LLM vendors close the gap.',
        },
        {
          heading: 'WHY THIS STRATEGY, WHY NOW',
          body: 'Two conditions make this the right moment for selective investment. First, OCC\'s push explainability shift creates a procurement gate that generic LLM integrations cannot clear — audit-defensible, citation-traceable narrative output is a competitive requirement, not a differentiator. Second, community bank CFOs lack the prompt-engineering sophistication to operationalise general LLM tools for board reporting without embedded domain scaffolding. Banking-domain prompt engineering — whether GPT-4o or Claude 3.5 — without embedded domain scaffolding offers a capital-efficient path to differentiated output quality that validates the moat thesis before heavier ML infrastructure investment is authorised.',
        },
        {
          heading: 'EVIDENCE BASE, CONFIDENCE LEVEL, AND CURRENT-STATE GAP',
          body: 'Supporting evidence is structurally strong but operationally conditional: CFO workflows are confirmed as manual and board-reporting pain is documented. A critical prior question must be answered before investment is framed as greenfield: is Finlytica already executing banking-domain prompt engineering or delivering structured narrative tooling in any form? If yes, the strategy shifts from initiation to acceleration — and existing output quality becomes the baseline for the week-12 differentiation test.',
        },
        {
          heading: 'TRADEOFFS AND DOWNSIDE SCENARIOS',
          body: 'The primary downside is a timeline asymmetry. General LLM vendors iterate faster than vertical AI specialists in most historical analogues. A GPT-4o banking-specific plug-in — or a Microsoft Copilot financial services accelerator — could bridge the domain capability gap within 6 months, compressing Finlytica\'s defensibility window. Over-investing in a moat that commoditises before it converts to retention premium is the critical failure mode to manage.',
        },
        {
          heading: 'EXECUTION PATH AND GOVERNANCE',
          body: 'Phase one: structured prompt engineering over existing frontier models using a banking-domain system prompt library covering call report, ALCO, and board-narrative templates — no fine-tuning infrastructure, low infrastructure cost, 8–12 weeks. Phase two: fine-tuning evaluation on de-identified client board report data, contingent on phase-one output quality evidence. Output must be citation-traceable with source data lineage to satisfy OCC SR 11-7 model risk standards.',
        },
        {
          heading: 'CEO DECISION FRAMING',
          body: 'This is a selective, staged investment — not a platform bet. Before authorising any sprint, confirm whether Finlytica is already doing this in any form; understand existing prompt sophistication; analyse-assisted narrative tooling; or informed LLM use in delivery. If so, the risk profile improves — the question becomes how to systematise and defend existing capability, not whether to build it. Either path requires the client substitution survey and sales audit this week. A commitment to commodity direction without a documented response cedes the CFO relationship to tools that do not require Finlytica\'s margin.',
        },
      ],
      keyDecisions: [
        'Confirm whether Finlytica already has banking-domain prompt or narrative tooling in production',
        'Authorise five-client substitution survey and 90-day sales conversation audit before any engineering sprint is scoped',
        'Treat week-12 product steering review as a genuine go/no-go gate on fine-tuning investment',
      ],
      callToAction: 'This week: audit internal delivery practices for existing LLM or narrative tooling; then commission the five-client substitution survey and 90-day sales conversation review before any engineering sprint is scoped.',
      validationCheckpoints: [
        'Week 4: internal delivery audit complete, existing capability baseline documented',
        'Week 8: product steering review confirms whether fine-tuning is premature',
        'Week 12: go/no-go decision on fine-tuning based on direct pilot evidence',
      ],
      readinessWarnings: [
        'Investment framing is premature if current internal delivery practices have not been inventoried first',
        'Client short-substitution data for LLM completing the narrative does not yet exist — not confirmed',
        'Fine-tuning cost may exceed engineering capacity; governance guardrails must be enforced rigorously',
      ],
    },
  },

  strategyBasis: {
    company:              'Finlytica',
    industry:             '',
    domain:               '',
    workflow:             'How does Finlytica\'s managed-services model scale, and what does the platform transition look like?',
    targetCustomer:       'CFO / Exec Sponsor',
    strategicThesis:      'Finlytica occupies a defensible but constrained niche in community banking analytics by leading with managed services as trust infrastructure rather than as a delivery efficiency play. The services-led model is simultaneously a competitive moat and a unit-economics ceiling: it generates the relationships that enable adoption but limits growth without platform leverage or self-service optionality. The central strategic question is not whether to build a platform tier, but when and how — and whether that decision is urgent given competitive consolidation signals.',
    businessProblem:      'Understand how Finlytica\'s managed-services model can scale and what the platform transition path looks like given competitive consolidation signals in community banking analytics.',
    opportunity:          'Build a banking-domain LLM narrative layer — grounded in call report structures, regulatory language, and examiner conventions — to convert a current delivery feature into a regulatory moat before general LLM vendors close the differentiation window.',
    recommendedDirection: 'Finlytica is likely following a consultative-entry, gradual platformisation path — consistent with how community banking analytics vendors typically evolve, though the timeline and trigger for platform-first motion remains unclear.',
    confidenceLevel:      'Medium',
    readinessLevel:       '',
  },

  evidenceChain: {
    stage1Intent:          'Finlytica is a specialised analytics platform targeting community banks — institutions that are typically analytics-light and make decisions by relationship and intuition rather than structured data analysis. It likely positions itself as a hybrid of consulting trust and SaaS convenience, competing less on feature depth than on operational fit.',
    stage2EvidenceSummary: 'Stage 2 retrieval directionally confirmed the services-led commercial model and surfaced a meaningful capability gap in self-service analytics maturity relative to more mature vendors targeting adjacent segments. FDIC third-party risk guidance is structural — regulatory constraint on analytics vendors is verified, not inferred.',
    stage3Synthesis:       'Core thesis is grounded in multiple independent evidence sources. Commercial model specifics remain unconfirmed from primary sources, limiting confidence to medium. The regulatory moat thesis is the highest-confidence strategic insight.',
    stage4UserContextAdditions: [
      'CFO and board sponsor persona selected — narrative must be board-ready, citation-traceable, and OCC-defensible.',
    ],
    keyInsights: [
      'Services as trust infrastructure, not delivery mechanism: Finlytica\'s advisory engagement is not an inefficiency to be platformised away — it is the actual value proposition in a market where analytics adoption is blocked by trust, not technology.',
      'Regulatory depth as underexploited competitive moat: FDIC third-party risk governance makes compliance depth a selection criterion, not merely a qualification bar. Compliance reporting automation is the highest-leverage adjacency.',
      'Platform transition timing is more urgent than roadmap suggests: Evidence from adjacent segments places the managed-to-self-service migration window at 12–18 months — far shorter than a traditional multi-year platform investment horizon.',
    ],
    supportingClaims: [
      'Community banks make analytics decisions by relationship and intuition, not structured data analysis',
      'Finlytica positions as an "analytics partnership," not a SaaS product, per its own published language',
      'FDIC third-party risk guidance explicitly governs analytics vendors in community banking',
      'Adjacent platform vendors (Nymbus, Apiture) bundle analytics rather than lead with analytics depth',
      'Comparable vendors completed managed-to-self-service tier transitions in 12–18 months in adjacent segments',
    ],
    risks: [
      'Compliance interpretation errors carry reputational and liability exposure beyond what an analytics vendor should own',
      'Regional bank expansion is structurally constrained — regional banks expect self-service analytics maturity Finlytica does not currently offer',
      'AI-native explanation layer vendors represent a time-bounded threat to the explainability opportunity — differentiation window estimated at 2–3 years',
      'Over-investing in a moat that commoditises before converting to retention premium is the central failure mode',
    ],
    assumptions: [],
    unresolvedQuestions: [
      'Is Finlytica already executing banking-domain prompt engineering or delivering structured narrative tooling in any form?',
      'What is the actual per-seat or per-engagement pricing structure — retainer or transaction-based?',
      'What is the current client NPS and renewal driver — is board narrative the leading retention signal?',
    ],
    recommendedNextActions: [
      'Deepen compliance adjacency via partnership',
      'Introduce a self-service data access tier',
      'Build banking-domain LLM narrative layer as regulatory moat',
    ],
    artifactCandidates: [
      'Build GCC-Ready BBA/AML Explainability Infrastructure',
      'Product Manager — double down variant',
      'Deprioritise Direct Enterprise',
      'Operations Leader — maintain variant',
    ],
  },

  executionImplications: {
    likelyBusinessUnits:                [],
    executiveLeadershipImplications:    [],
    productPdlcImplications:            [],
    engineeringTechnologyImplications:  [],
    designUxImplications:               [],
    dataAnalyticsImplications:          [],
    salesImplications:                  [],
    marketingImplications:              [],
    customerSuccessImplications:        [],
    operationsImplications:             [],
    financeImplications:                [],
    legalComplianceImplications:        [],
    supportServiceImplications:         [],
    peopleChangeManagementImplications: [],
    partnershipsEcosystemImplications:  [],
  },

  lineage: {
    sourceStage:           'Stage 4',
    sourceArtifactVersion: 'v2',
    basedOnStages:         ['Stage 1', 'Stage 2', 'Stage 3', 'Stage 4'],
    citationsPreserved:    false,
    userEdited:            true,
    notes:                 'CFO/Board persona refinement applied — adjusted narrative framing for board-level audience and OCC explainability requirement.',
  },
}
