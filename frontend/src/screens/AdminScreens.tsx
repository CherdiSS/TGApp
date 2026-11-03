import { useEffect, useState } from 'react'
import { api, rub, type Category, type Item } from '../api'
import { BackButton, MainButton } from '../components/TgButtons'
import { ErrorBox, Header, Loader, Photo } from '../components/ui'
import { haptic, showAlert, showConfirm } from '../telegram'

export function AdminScreen({ onBack, onEdit }: {
  onBack: () => void
  onEdit: (item: Item | null, categoryId: number, categories: Category[]) => void
}) {
  const [menu, setMenu] = useState<Category[] | null>(null)
  const [error, setError] = useState('')

  const load = () => {
    setError('')
    api.admin.menu().then(setMenu).catch((e) => setError(e.message))
  }
  useEffect(load, [])

  const toggle = async (it: Item) => {
    haptic.select()
    setMenu((m) => m && m.map((c) => ({
      ...c, items: c.items.map((x) => (x.id === it.id ? { ...x, available: !x.available } : x)),
    })))
    try {
      await api.admin.updateItem(it.id, { available: !it.available })
    } catch (e) {
      await showAlert((e as Error).message)
      load()
    }
  }

  // window.prompt в WebView Telegram работает не везде — поэтому инлайн-форма.
  const [newCat, setNewCat] = useState({ name: '', emoji: '🍽' })
  const addCategory = async () => {
    const name = newCat.name.trim()
    if (!name) return
    try {
      await api.admin.createCategory(name, newCat.emoji.trim())
      setNewCat({ name: '', emoji: '🍽' })
      load()
    } catch (e) {
      showAlert((e as Error).message)
    }
  }

  const removeCategory = async (c: Category) => {
    const ok = await showConfirm(
      c.items.length ? `Удалить «${c.name}» вместе с ${c.items.length} позициями?` : `Удалить «${c.name}»?`,
    )
    if (!ok) return
    try {
      await api.admin.deleteCategory(c.id)
      load()
    } catch (e) {
      showAlert((e as Error).message)
    }
  }

  return (
    <div className="screen">
      <Header left={<BackButton onClick={onBack} />} title="Редактор меню" subtitle="Стоп-лист, цены и новые позиции" />
      {error ? <ErrorBox message={error} onRetry={load} /> : !menu ? <Loader /> : (
        <>
          {menu.map((c) => (
            <section key={c.id} className="admin-cat">
              <div className="admin-cat__head">
                <h2>{c.emoji} {c.name}</h2>
                <button className="link-btn link-btn--danger" onClick={() => removeCategory(c)}>Удалить</button>
              </div>
              <div className="panel">
                {c.items.map((it) => (
                  <div key={it.id} className={`line ${it.available ? '' : 'line--off'}`}>
                    <button className="line__tap" onClick={() => onEdit(it, c.id, menu)}>
                      <Photo src={it.image_url} alt={it.name} emoji={c.emoji} />
                      <div className="line__info">
                        <div className="line__name">{it.name}</div>
                        <div className="line__price">{rub(it.price)}{!it.available && ' · в стоп-листе'}</div>
                      </div>
                    </button>
                    <label className="switch" title="В наличии">
                      <input type="checkbox" checked={it.available} onChange={() => toggle(it)} />
                      <span />
                    </label>
                  </div>
                ))}
                <button className="add-row" onClick={() => onEdit(null, c.id, menu)}>+ Добавить позицию</button>
              </div>
            </section>
          ))}
          <h3 className="label">Новая категория</h3>
          <div className="panel new-cat">
            <input className="new-cat__emoji" value={newCat.emoji} maxLength={4} aria-label="Эмодзи"
              onChange={(e) => setNewCat((n) => ({ ...n, emoji: e.target.value }))} />
            <input placeholder="Например, Супы" value={newCat.name} maxLength={40}
              onChange={(e) => setNewCat((n) => ({ ...n, name: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && addCategory()} />
            <button className="btn btn--small" disabled={!newCat.name.trim()} onClick={addCategory}>Добавить</button>
          </div>
          <div className="spacer" />
        </>
      )}
    </div>
  )
}

export function ItemEditor({ item, categoryId, categories, onDone }: {
  item: Item | null
  categoryId: number
  categories: Category[]
  onDone: () => void
}) {
  const [form, setForm] = useState({
    name: item?.name ?? '',
    description: item?.description ?? '',
    price: item ? String(item.price) : '',
    weight: item?.weight ?? '',
    image_url: item?.image_url ?? '',
    category_id: item?.category_id ?? categoryId,
    available: item?.available ?? true,
  })
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  const price = Number(form.price)
  const valid = form.name.trim() && form.price !== '' && Number.isInteger(price) && price >= 0

  const save = async () => {
    if (!valid || saving) return
    setSaving(true)
    const body = { ...form, name: form.name.trim(), price }
    try {
      if (item) await api.admin.updateItem(item.id, body)
      else await api.admin.createItem(body)
      haptic.success()
      onDone()
    } catch (e) {
      haptic.error()
      await showAlert((e as Error).message)
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!item || !(await showConfirm(`Удалить «${item.name}»?`))) return
    try {
      await api.admin.deleteItem(item.id)
      onDone()
    } catch (e) {
      showAlert((e as Error).message)
    }
  }

  return (
    <div className="screen">
      <Header left={<BackButton onClick={onDone} />} title={item ? 'Редактирование' : 'Новая позиция'} />

      <div className="editor-photo">
        <Photo src={form.image_url} alt={form.name} />
      </div>

      <div className="panel form">
        <label>Название<input value={form.name} maxLength={80} onChange={(e) => set('name', e.target.value)} placeholder="Капучино" /></label>
        <label>Описание<textarea rows={2} maxLength={300} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Состав, особенности" /></label>
        <div className="form__row">
          <label>Цена, ₽<input inputMode="numeric" value={form.price} onChange={(e) => set('price', e.target.value.replace(/\D/g, ''))} placeholder="250" /></label>
          <label>Вес / объём<input value={form.weight} maxLength={30} onChange={(e) => set('weight', e.target.value)} placeholder="300 мл" /></label>
        </div>
        <label>Категория
          <select value={form.category_id} onChange={(e) => set('category_id', Number(e.target.value))}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
          </select>
        </label>
        <label>Ссылка на фото<input value={form.image_url} maxLength={500} onChange={(e) => set('image_url', e.target.value)} placeholder="https://…" /></label>
        <label className="form__check">
          <input type="checkbox" checked={form.available} onChange={(e) => set('available', e.target.checked)} />
          В наличии
        </label>
      </div>

      {item && <button className="btn btn--danger btn--wide" onClick={remove}>Удалить позицию</button>}
      <div className="spacer" />
      <MainButton text={item ? 'Сохранить' : 'Добавить в меню'} onClick={save} disabled={!valid} progress={saving} />
    </div>
  )
}
