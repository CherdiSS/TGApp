import { useState, type ReactNode } from 'react'
import { STATUS, type OrderStatus } from '../api'
import { haptic } from '../telegram'

export function Photo({ src, alt, emoji = '🍽' }: { src: string; alt: string; emoji?: string }) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>(src ? 'loading' : 'error')
  return (
    <div className={`photo photo--${state}`}>
      {state !== 'error' && (
        <img src={src} alt={alt} loading="lazy" onLoad={() => setState('ok')} onError={() => setState('error')} />
      )}
      {state === 'error' && <span className="photo__emoji">{emoji}</span>}
    </div>
  )
}

export function Stepper({ qty, onAdd, onRemove, compact }: {
  qty: number
  onAdd: () => void
  onRemove: () => void
  compact?: boolean
}) {
  const add = () => { haptic.tap(); onAdd() }
  const remove = () => { haptic.tap(); onRemove() }
  return (
    <div className={`stepper ${compact ? 'stepper--compact' : ''}`}>
      <button onClick={remove} aria-label="Убрать">−</button>
      <span>{qty}</span>
      <button onClick={add} aria-label="Добавить">+</button>
    </div>
  )
}

export function StatusBadge({ status }: { status: OrderStatus }) {
  const s = STATUS[status]
  return <span className={`badge badge--${s.tone}`}>{s.label}</span>
}

export function Header({ title, subtitle, left, right }: {
  title: ReactNode
  subtitle?: ReactNode
  left?: ReactNode
  right?: ReactNode
}) {
  return (
    <header className="header">
      {left}
      <div className="header__titles">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {right && <div className="header__right">{right}</div>}
    </header>
  )
}

export function Loader() {
  return <div className="center"><span className="spinner spinner--accent" /></div>
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="center empty">
      <div className="empty__emoji">😕</div>
      <p>{message}</p>
      {onRetry && <button className="btn btn--ghost" onClick={onRetry}>Повторить</button>}
    </div>
  )
}

export function formatDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
