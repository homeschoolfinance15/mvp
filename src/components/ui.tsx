import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import type { ConnectorStatus, InviteCodeStatus, ProfileStatus } from '../lib/types'

/* -------------------------------------------------------------------------- */
/* Wordmark                                                                    */
/* -------------------------------------------------------------------------- */

export function Wordmark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const scale = { sm: 'text-lg', md: 'text-xl', lg: 'text-2xl' }[size]
  return (
    <span className={`${scale} font-serif font-bold tracking-[-0.03em] text-fg uppercase`}>
      Amazing<span className="text-gold-dim">.</span>
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* Button                                                                      */
/* -------------------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  loading?: boolean
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-fg text-white hover:bg-[#353532] active:bg-black border border-fg font-medium',
  secondary:
    'bg-white text-fg border border-line-strong hover:border-fg',
  ghost: 'bg-transparent text-muted border border-transparent hover:text-fg hover:bg-raised',
  danger:
    'bg-transparent text-negative border border-[#e6b5ad] hover:bg-[#fff0ec] hover:border-negative',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  children,
  className = '',
  ...rest
}: ButtonProps) {
  const sizing = size === 'sm' ? 'h-9 px-4 text-xs' : 'h-11 px-5 text-sm'
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-[4px] transition-colors duration-300 disabled:cursor-not-allowed disabled:opacity-45 ${sizing} ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {loading && <Spinner />}
      {children}
    </button>
  )
}

export function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-3 animate-spin rounded-full border border-current border-t-transparent"
    />
  )
}

/* -------------------------------------------------------------------------- */
/* Form fields                                                                 */
/* -------------------------------------------------------------------------- */

// Controls are full-width by design. To constrain one, wrap it in a sized
// element — passing a width via className will not win, since Tailwind resolves
// conflicting width utilities by stylesheet order, not by attribute order.
const CONTROL =
  'w-full rounded-[4px] border border-line bg-white px-4 text-sm text-fg placeholder:text-dim/80 ' +
  'transition-colors duration-300 hover:border-line-strong focus:border-fg focus:outline-none ' +
  'disabled:opacity-50'

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="eyebrow mb-2 block">{label}</span>
      {children}
      {hint && !error && <span className="mt-1.5 block text-xs text-dim">{hint}</span>}
      {error && <span className="mt-1.5 block text-xs text-negative">{error}</span>}
    </label>
  )
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props
  return <input {...rest} className={`${CONTROL} h-12 ${className}`} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props
  return <textarea {...rest} className={`${CONTROL} resize-y py-2.5 leading-relaxed ${className}`} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', ...rest } = props
  return <select {...rest} className={`${CONTROL} h-10 cursor-pointer pr-8 ${className}`} />
}

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                    */
/* -------------------------------------------------------------------------- */

export function Panel({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={`panel ${className}`}>{children}</div>
}

export function SectionHeader({
  title,
  caption,
  action,
}: {
  title: string
  caption?: string
  action?: ReactNode
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="eyebrow">{title}</h2>
        {caption && <p className="mt-1.5 text-sm text-muted">{caption}</p>}
      </div>
      {action}
    </div>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[6px] border border-dashed border-line-strong px-6 py-12 text-center text-sm text-dim">
      {children}
    </div>
  )
}

export function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Panel className="px-5 py-4">
      <div className="eyebrow">{label}</div>
      <div className="mt-2 text-3xl font-light tracking-tight tabular-nums text-fg">{value}</div>
    </Panel>
  )
}

/* -------------------------------------------------------------------------- */
/* Status badges                                                               */
/* -------------------------------------------------------------------------- */

type AnyStatus = ProfileStatus | ConnectorStatus | InviteCodeStatus

// Green reads "in good standing", gold "needs a look", red "sanctioned",
// grey "inert". Kept in one map so the three status enums stay visually
// consistent wherever they appear.
const STATUS_TONE: Record<AnyStatus, string> = {
  active: 'text-positive border-[#b9d8c4] bg-[#eff8f2]',
  pending: 'text-[#8a4b00] border-[#efc98f] bg-gold-wash',
  under_review: 'text-[#8a4b00] border-[#efc98f] bg-gold-wash',
  limited: 'text-[#8a4b00] border-[#efc98f] bg-gold-wash',
  restricted: 'text-negative border-[#e6b5ad] bg-[#fff0ec]',
  suspended: 'text-negative border-[#e6b5ad] bg-[#fff0ec]',
  removed: 'text-dim border-line bg-raised',
  paused: 'text-dim border-line bg-raised',
  disabled: 'text-dim border-line bg-raised',
  exhausted: 'text-dim border-line bg-raised',
  expired: 'text-dim border-line bg-raised',
}

export function StatusBadge({ status }: { status: AnyStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.6875rem] font-medium tracking-wide whitespace-nowrap ${STATUS_TONE[status]}`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* Copyable code                                                               */
/* -------------------------------------------------------------------------- */

export function CopyCode({
  code,
  size = 'md',
}: {
  code: string
  size?: 'sm' | 'md' | 'lg'
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
    } catch {
      // Clipboard is unavailable over plain http on some hosts; the code is
      // selectable either way, so fall back to selecting it for the user.
      const range = document.createRange()
      const node = document.getElementById(`code-${code}`)
      if (node) {
        range.selectNodeContents(node)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
    }
  }

  const sizing = {
    sm: 'px-2.5 py-1 text-xs',
    md: 'px-3 py-1.5 text-sm',
    lg: 'px-4 py-2.5 text-lg',
  }[size]

  return (
    <span className="inline-flex items-center gap-2">
      <code id={`code-${code}`} className={`code-chip rounded-sm font-medium ${sizing}`}>
        {code}
      </code>
      <button
        type="button"
        onClick={copy}
        className="text-xs text-dim transition-colors hover:text-gold"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

export function Notice({ tone, children }: { tone: 'error' | 'success'; children: ReactNode }) {
  if (!children) return null
  const styles =
    tone === 'error'
      ? 'border-[#e6b5ad] bg-[#fff0ec] text-negative'
      : 'border-[#b9d8c4] bg-[#eff8f2] text-positive'
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-sm border px-3.5 py-2.5 text-sm ${styles}`}>
      {children}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Modal                                                                       */
/* -------------------------------------------------------------------------- */

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div
        className="fixed inset-0 bg-fg/45 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 my-auto w-full max-w-lg rounded-[6px] border border-line bg-white"
      >
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-sm font-medium tracking-tight text-fg">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-dim transition-colors hover:text-fg"
          >
            &#10005;
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                        */
/* -------------------------------------------------------------------------- */

export function Initials({ name }: { name: string }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('')
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-[#ead5ad] bg-surface text-xs font-semibold text-muted">
      {letters || '—'}
    </span>
  )
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function PageLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center text-dim">
      <Spinner />
    </div>
  )
}
