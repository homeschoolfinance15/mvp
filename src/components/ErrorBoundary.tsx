import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * A crash during render unmounts the whole tree and leaves an empty page, which
 * on a dark theme is indistinguishable from a site that never loaded at all.
 * This turns that into something a person can read and report.
 *
 * Styles are inline rather than Tailwind classes on purpose — if the stylesheet
 * itself failed to load, class-based styling would render this unreadable.
 */
interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled error in render tree', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1.5rem',
          background: '#fffdf7',
          color: '#191511',
          fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ maxWidth: '32rem' }}>
          <div
            style={{
              fontSize: '0.6875rem',
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: '#c66d00',
            }}
          >
            Amazing
          </div>
          <h1 style={{ marginTop: '1.25rem', fontSize: '1.5rem', fontWeight: 500 }}>
            Something went wrong on this page
          </h1>
          <p style={{ marginTop: '0.875rem', lineHeight: 1.65, color: '#422f20' }}>
            The page failed to load rather than loading empty. Reloading often clears it. If it
            keeps happening, the message below is the useful part to pass on.
          </p>
          <pre
            style={{
              marginTop: '1.5rem',
              padding: '0.875rem 1rem',
              background: '#fff0ec',
              border: '1px solid #e6b5ad',
              borderRadius: '0.25rem',
              color: '#9d3f32',
              fontSize: '0.8125rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: '1.5rem',
              height: '2.5rem',
              padding: '0 1rem',
              background: '#ffbb63',
              color: '#191511',
              border: 'none',
              borderRadius: '0.125rem',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Reload the page
          </button>
        </div>
      </div>
    )
  }
}
