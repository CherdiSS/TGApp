import { useEffect, useRef, useState } from 'react'
import { rub, type Category, type Item } from '../api'
import { useCart } from '../cart'
import { MainButton } from '../components/TgButtons'
import { Header, Photo, Stepper } from '../components/ui'
import { haptic, tgUser } from '../telegram'

interface Props {
  menu: Category[]
  isAdmin: boolean
  onCart: () => void
  onOrders: () => void
  onAdmin: () => void
}

export function MenuScreen({ menu, isAdmin, onCart, onOrders, onAdmin }: Props) {
  const cart = useCart()
  const [active, setActive] = useState(menu[0]?.id)
  const [opened, setOpened] = useState<Item | null>(null)
  const sections = useRef(new Map<number, HTMLElement>())
  const tabs = useRef<HTMLDivElement>(null)
  const scrollingTo = useRef(false)

  // Подсветка активной категории при прокрутке.
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        if (scrollingTo.current) return
        const visible = entries.filter((e) => e.isIntersecting)
        if (visible.length) setActive(Number(visible[0].target.getAttribute('data-id')))
      },
      { rootMargin: '-120px 0px -65% 0px' },
    )
    sections.current.forEach((el) => obs.observe(el))
    return () => obs.disconnect()
  }, [menu])

  useEffect(() => {
    tabs.current?.querySelector<HTMLElement>(`[data-tab="${active}"]`)
      ?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [active])

  const jump = (id: number) => {
    haptic.select()
    setActive(id)
    const el = sections.current.get(id)
    if (!el) return
    scrollingTo.current = true
    window.scrollTo({ top: el.offsetTop - 64, behavior: 'smooth' })
    window.setTimeout(() => (scrollingTo.current = false), 700)
  }

  const hello = tgUser?.first_name ? `${tgUser.first_name}, что закажем?` : 'Что закажем сегодня?'

  return (
    <div className="screen screen--menu">
      <Header
        title="Кафе «Ложка»"
        subtitle={hello}
        right={
          <>
            {isAdmin && (
              <button className="icon-btn" onClick={onAdmin} aria-label="Админка" title="Редактировать меню">⚙️</button>
            )}
            <button className="icon-btn" onClick={onOrders} aria-label="Мои заказы" title="Мои заказы">🧾</button>
          </>
        }
      />

      <div className="promo">
        <div>
          <b>Самовывоз без очереди</b>
          <span>Закажите заранее — придёте, а всё уже готово</span>
        </div>
        <span className="promo__emoji">🛍️</span>
      </div>

      <nav className="tabs" ref={tabs}>
        {menu.map((c) => (
          <button
            key={c.id}
            data-tab={c.id}
            className={`tab ${active === c.id ? 'tab--active' : ''}`}
            onClick={() => jump(c.id)}
          >
            {c.emoji} {c.name}
          </button>
        ))}
      </nav>

      {menu.map((c) => (
        <section
          key={c.id}
          data-id={c.id}
          className="section"
          ref={(el) => { if (el) sections.current.set(c.id, el); else sections.current.delete(c.id) }}
        >
          <h2>{c.name}</h2>
          <div className="grid">
            {c.items.map((it) => (
              <article key={it.id} className="card" onClick={() => setOpened(it)}>
                <Photo src={it.image_url} alt={it.name} emoji={c.emoji} />
                <div className="card__body">
                  <div className="card__name">{it.name}</div>
                  {it.weight && <div className="card__weight">{it.weight}</div>}
                  <div className="card__footer" onClick={(e) => e.stopPropagation()}>
                    {cart.qty(it.id) > 0 ? (
                      <Stepper compact qty={cart.qty(it.id)} onAdd={() => cart.add(it)} onRemove={() => cart.remove(it.id)} />
                    ) : (
                      <button className="price-btn" onClick={() => { haptic.tap(); cart.add(it) }}>
                        {rub(it.price)} <span>+</span>
                      </button>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}

      <div className="spacer" />

      {opened && <ItemSheet item={opened} emoji={menu.find((c) => c.id === opened.category_id)?.emoji} onClose={() => setOpened(null)} />}

      {cart.count > 0 && !opened && (
        <MainButton text={`Корзина (${cart.count})`} aside={rub(cart.total)} onClick={onCart} />
      )}
    </div>
  )
}

function ItemSheet({ item, emoji, onClose }: { item: Item; emoji?: string; onClose: () => void }) {
  const cart = useCart()
  const qty = cart.qty(item.id)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={item.name}>
        <div className="sheet__grip" />
        <Photo src={item.image_url.replace('w=600', 'w=900')} alt={item.name} emoji={emoji} />
        <div className="sheet__body">
          <h3>{item.name}</h3>
          {item.weight && <div className="card__weight">{item.weight}</div>}
          {item.description && <p>{item.description}</p>}
          <div className="sheet__actions">
            <b className="sheet__price">{rub(item.price)}</b>
            {qty > 0 ? (
              <Stepper qty={qty} onAdd={() => cart.add(item)} onRemove={() => cart.remove(item.id)} />
            ) : (
              <button className="btn" onClick={() => { haptic.tap(); cart.add(item) }}>В корзину</button>
            )}
          </div>
        </div>
      </div>
      <MainButton text={qty > 0 ? 'Готово' : 'Закрыть'} onClick={onClose} />
    </div>
  )
}
