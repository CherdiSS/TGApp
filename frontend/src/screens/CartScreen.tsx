import { useEffect, useState } from 'react'
import { api, ApiError, rub, type Order } from '../api'
import { useCart } from '../cart'
import { BackButton, MainButton } from '../components/TgButtons'
import { Header, Photo, Stepper } from '../components/ui'
import { ensureWriteAccess, haptic, setClosingConfirmation, showAlert, showConfirm } from '../telegram'

const PICKUP = [
  { label: 'Как можно скорее', minutes: 0 },
  { label: 'Через 30 мин', minutes: 30 },
  { label: 'Через час', minutes: 60 },
]

function pickupLabel(minutes: number) {
  if (!minutes) return 'Как можно скорее'
  const t = new Date(Date.now() + minutes * 60_000)
  return `к ${t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
}

export function CartScreen({ onBack, onOrdered, onMenuChanged }: {
  onBack: () => void
  onOrdered: (o: Order) => void
  onMenuChanged: () => void
}) {
  const cart = useCart()
  const [comment, setComment] = useState('')
  const [pickup, setPickup] = useState(0)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (cart.count === 0) onBack()
  }, [cart.count, onBack])

  // Не даём случайно закрыть приложение с непустой корзиной.
  useEffect(() => {
    setClosingConfirmation(true)
    return () => setClosingConfirmation(false)
  }, [])

  const clear = async () => {
    if (await showConfirm('Очистить корзину?')) cart.clear()
  }

  const submit = async () => {
    if (sending) return
    setSending(true)
    try {
      await ensureWriteAccess()
      const order = await api.createOrder({
        items: cart.lines.map((l) => ({ item_id: l.item.id, qty: l.qty })),
        comment,
        pickup_time: pickupLabel(pickup),
      })
      haptic.success()
      cart.clear()
      onOrdered(order)
    } catch (e) {
      haptic.error()
      const msg = e instanceof ApiError ? e.message : 'Не удалось оформить заказ'
      await showAlert(msg)
      if (e instanceof ApiError && e.status === 409) onMenuChanged()
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="screen">
      <Header
        left={<BackButton onClick={onBack} />}
        title="Корзина"
        right={<button className="link-btn" onClick={clear}>Очистить</button>}
      />

      <div className="panel">
        {cart.lines.map(({ item, qty }) => (
          <div key={item.id} className="line">
            <Photo src={item.image_url} alt={item.name} />
            <div className="line__info">
              <div className="line__name">{item.name}</div>
              <div className="line__price">{rub(item.price * qty)}</div>
            </div>
            <Stepper compact qty={qty} onAdd={() => cart.add(item)} onRemove={() => cart.remove(item.id)} />
          </div>
        ))}
      </div>

      <h3 className="label">Когда заберёте?</h3>
      <div className="chips">
        {PICKUP.map((p) => (
          <button
            key={p.minutes}
            className={`chip ${pickup === p.minutes ? 'chip--active' : ''}`}
            onClick={() => { haptic.select(); setPickup(p.minutes) }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <h3 className="label">Комментарий</h3>
      <div className="panel">
        <textarea
          className="textarea"
          placeholder="Например: без сахара, на миндальном молоке"
          maxLength={500}
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>

      <div className="panel summary">
        <div><span>Товары, {cart.count} шт.</span><span>{rub(cart.total)}</span></div>
        <div className="summary__total"><span>Итого</span><span>{rub(cart.total)}</span></div>
      </div>
      <p className="hint">Оплата при получении. Бот пришлёт сообщение, когда заказ будет готов.</p>

      <div className="spacer" />
      <MainButton text="Оформить заказ" aside={rub(cart.total)} onClick={submit} progress={sending} />
    </div>
  )
}
