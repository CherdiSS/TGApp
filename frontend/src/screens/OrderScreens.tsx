import { useEffect, useState } from 'react'
import { api, rub, type Order, type OrderStatus } from '../api'
import { BackButton, MainButton } from '../components/TgButtons'
import { ErrorBox, formatDate, Header, Loader, StatusBadge } from '../components/ui'
import { haptic } from '../telegram'

const STEPS: { status: OrderStatus; title: string; emoji: string }[] = [
  { status: 'new', title: 'Отправлен', emoji: '🧾' },
  { status: 'accepted', title: 'Готовится', emoji: '👨‍🍳' },
  { status: 'ready', title: 'Готов', emoji: '🍽' },
  { status: 'completed', title: 'Выдан', emoji: '🤝' },
]

const FINAL: OrderStatus[] = ['completed', 'cancelled']

/** Экран заказа с «живым» статусом: опрашиваем API, пока заказ не завершён. */
export function OrderScreen({ initial, onBack, onMenu }: { initial: Order; onBack: () => void; onMenu: () => void }) {
  const [order, setOrder] = useState(initial)

  useEffect(() => {
    if (FINAL.includes(order.status)) return
    const t = window.setInterval(async () => {
      try {
        const fresh = await api.order(order.id)
        setOrder((prev) => {
          if (prev.status !== fresh.status) haptic.success()
          return fresh
        })
      } catch { /* сеть моргнула — попробуем в следующий раз */ }
    }, 4000)
    return () => window.clearInterval(t)
  }, [order.id, order.status])

  const stepIdx = STEPS.findIndex((s) => s.status === order.status)
  const cancelled = order.status === 'cancelled'

  return (
    <div className="screen">
      <Header left={<BackButton onClick={onBack} />} title={`Заказ №${order.id}`} subtitle={formatDate(order.created_at)} />

      <div className={`hero ${cancelled ? 'hero--cancel' : ''}`}>
        <div className="hero__emoji">{cancelled ? '❌' : STEPS[Math.max(stepIdx, 0)].emoji}</div>
        <StatusBadge status={order.status} />
        {order.pickup_time && !cancelled && <p>Самовывоз: {order.pickup_time}</p>}
      </div>

      {!cancelled && (
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.status} className={i < stepIdx ? 'done' : i === stepIdx ? 'current' : ''}>
              <span className="steps__dot" />
              {s.title}
            </li>
          ))}
        </ol>
      )}

      <div className="panel">
        {order.items.map((it) => (
          <div key={it.item_id} className="row">
            <span>{it.name} <span className="muted">× {it.qty}</span></span>
            <span>{rub(it.price * it.qty)}</span>
          </div>
        ))}
        <div className="row row--total"><span>Итого</span><span>{rub(order.total)}</span></div>
        {order.comment && <p className="muted comment">💬 {order.comment}</p>}
      </div>
      {!FINAL.includes(order.status) && (
        <p className="hint">Статус обновляется автоматически. Бот тоже пришлёт уведомление.</p>
      )}

      <div className="spacer" />
      <MainButton text="Вернуться в меню" onClick={onMenu} />
    </div>
  )
}

export function OrdersScreen({ onBack, onOpen }: { onBack: () => void; onOpen: (o: Order) => void }) {
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [error, setError] = useState('')

  const load = () => {
    setError('')
    api.orders().then(setOrders).catch((e) => setError(e.message))
  }
  useEffect(load, [])

  return (
    <div className="screen">
      <Header left={<BackButton onClick={onBack} />} title="Мои заказы" />
      {error ? <ErrorBox message={error} onRetry={load} /> : !orders ? <Loader /> : orders.length === 0 ? (
        <div className="center empty">
          <div className="empty__emoji">🍽</div>
          <p>Здесь появятся ваши заказы</p>
        </div>
      ) : (
        <div className="list">
          {orders.map((o) => (
            <button key={o.id} className="order-row" onClick={() => onOpen(o)}>
              <div className="order-row__top">
                <b>№{o.id}</b>
                <span className="muted">{formatDate(o.created_at)}</span>
              </div>
              <div className="order-row__items">{o.items.map((i) => `${i.name} × ${i.qty}`).join(', ')}</div>
              <div className="order-row__bottom">
                <StatusBadge status={o.status} />
                <b>{rub(o.total)}</b>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
