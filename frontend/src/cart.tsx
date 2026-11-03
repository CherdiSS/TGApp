import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react'
import type { Item } from './api'

export interface CartLine {
  item: Item
  qty: number
}

type State = Record<number, CartLine>
type Action =
  | { type: 'add'; item: Item }
  | { type: 'remove'; id: number }
  | { type: 'clear' }
  | { type: 'sync'; items: Item[] }

const MAX_QTY = 20
const KEY = 'cafe-cart-v1'

function reducer(state: State, a: Action): State {
  switch (a.type) {
    case 'add': {
      const cur = state[a.item.id]
      const qty = Math.min((cur?.qty ?? 0) + 1, MAX_QTY)
      return { ...state, [a.item.id]: { item: a.item, qty } }
    }
    case 'remove': {
      const cur = state[a.id]
      if (!cur) return state
      const next = { ...state }
      if (cur.qty <= 1) delete next[a.id]
      else next[a.id] = { ...cur, qty: cur.qty - 1 }
      return next
    }
    case 'clear':
      return {}
    case 'sync': {
      // Актуализируем цены/названия и выкидываем то, чего больше нет в меню.
      const byId = new Map(a.items.map((i) => [i.id, i]))
      const next: State = {}
      for (const line of Object.values(state)) {
        const fresh = byId.get(line.item.id)
        if (fresh) next[fresh.id] = { item: fresh, qty: line.qty }
      }
      return next
    }
  }
}

function load(): State {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

interface CartCtx {
  lines: CartLine[]
  count: number
  total: number
  qty: (id: number) => number
  add: (item: Item) => void
  remove: (id: number) => void
  clear: () => void
  sync: (items: Item[]) => void
}

const Ctx = createContext<CartCtx | null>(null)

export function CartProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, load)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
      /* приватный режим и т.п. — не критично */
    }
  }, [state])

  const value = useMemo<CartCtx>(() => {
    const lines = Object.values(state)
    return {
      lines,
      count: lines.reduce((s, l) => s + l.qty, 0),
      total: lines.reduce((s, l) => s + l.qty * l.item.price, 0),
      qty: (id) => state[id]?.qty ?? 0,
      add: (item) => dispatch({ type: 'add', item }),
      remove: (id) => dispatch({ type: 'remove', id }),
      clear: () => dispatch({ type: 'clear' }),
      sync: (items) => dispatch({ type: 'sync', items }),
    }
  }, [state])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useCart() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useCart outside CartProvider')
  return ctx
}
