import React from 'react'

const EMPTY_TEXT = 'Learning signals will appear as meaningful refinements, structural changes, uncertainty, and staleness events accumulate.'

const ORDER = [
  'Refinement patterns',
  'Stage-boundary lessons',
  'Assumption shifts',
  'SME validation needs',
  'Downstream implications',
  'Evidence gaps',
  'Failure modes',
]

export default function LearningSignals({ signals }) {
  const grouped = (signals || []).reduce((acc, signal) => {
    const key = signal.category || 'Refinement patterns'
    if (!acc[key]) acc[key] = []
    acc[key].push(signal)
    return acc
  }, {})
  const categories = ORDER.filter(key => grouped[key]?.length)

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r)',
      padding: '13px 15px',
      marginBottom: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: categories.length ? 10 : 0 }}>
        <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--accent)', flexShrink: 0 }}>
          *
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, flex: 1 }}>Learning Signals</span>
        {categories.length > 0 && (
          <span style={{
            fontSize: 8,
            fontFamily: 'var(--fm)',
            color: 'var(--muted)',
            padding: '1px 6px',
            borderRadius: 3,
            background: 'var(--s2)',
            border: '1px solid var(--border)',
          }}>
            {(signals || []).length}
          </span>
        )}
      </div>

      {!categories.length ? (
        <div style={{ fontSize: 10, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.65 }}>
          {EMPTY_TEXT}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {categories.map(category => (
            <div key={category}>
              <div style={{
                fontSize: 8,
                fontFamily: 'var(--fm)',
                color: 'var(--muted)',
                textTransform: 'uppercase',
                letterSpacing: '.06em',
                marginBottom: 5,
              }}>
                {category}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {grouped[category].map((signal, i) => (
                  <div key={`${category}-${i}`} style={{
                    fontSize: 10,
                    color: 'var(--muted2)',
                    lineHeight: 1.65,
                    paddingLeft: 10,
                    borderLeft: '2px solid rgba(59,130,246,.35)',
                  }}>
                    {signal.text}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
