import { tg } from './telegram'

export interface Item {
  id: number
  category_id: number
  name: string
  description: string
  price: number
  weight: string
  image_url: string
  available: boolean
  sort: number
}

export interface Category {
  id: number
  name: string
  emoji: string
  sort: number
  items: Item[]
}

export type OrderStatus = 'new' | 'accepted' | 'ready' | 'completed' | 'cancelled'

export interface Order {
  id: number
  items: { item_id: number; name: string; price: number; qty: number }[]
  total: number
  comment: string
  pickup_time: string
  status: OrderStatus
  created_at: string
  updated_at: string
}

export interface Me {
  id: number
  name: string
  is_admin: boolean
}

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  // Подписанные Telegram данные — бэкенд проверяет HMAC и по ним узнаёт пользователя.
  if (tg?.initData) headers.set('Authorization', `tma ${tg.initData}`)
  if (init.body) headers.set('Content-Type', 'application/json')

  let res: Response
  try {
    res = await fetch(`${BASE}/api${path}`, { ...init, headers })
  } catch {
    throw new ApiError(0, 'Нет связи с сервером')
  }
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = data?.detail
    const msg = typeof detail === 'string' ? detail : 'Что-то пошло не так'
    throw new ApiError(res.status, msg)
  }
  return data as T
}

const json = (body: unknown) => JSON.stringify(body)

export const api = {
  me: () => request<Me>('/me'),
  menu: () => request<Category[]>('/menu'),
  createOrder: (body: { items: { item_id: number; qty: number }[]; comment: string; pickup_time: string }) =>
    request<Order>('/orders', { method: 'POST', body: json(body) }),
  orders: () => request<Order[]>('/orders'),
  order: (id: number) => request<Order>(`/orders/${id}`),

  admin: {
    menu: () => request<Category[]>('/admin/menu'),
    createItem: (body: Omit<Item, 'id' | 'sort'>) =>
      request<Item>('/admin/items', { method: 'POST', body: json(body) }),
    updateItem: (id: number, body: Partial<Item>) =>
      request<Item>(`/admin/items/${id}`, { method: 'PATCH', body: json(body) }),
    deleteItem: (id: number) => request<void>(`/admin/items/${id}`, { method: 'DELETE' }),
    createCategory: (name: string, emoji: string) =>
      request<Category>('/admin/categories', { method: 'POST', body: json({ name, emoji }) }),
    deleteCategory: (id: number) => request<void>(`/admin/categories/${id}`, { method: 'DELETE' }),
  },
}

export const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`

export const STATUS: Record<OrderStatus, { label: string; tone: string }> = {
  new: { label: 'Ожидает подтверждения', tone: 'wait' },
  accepted: { label: 'Готовится', tone: 'cook' },
  ready: { label: 'Готов — можно забирать', tone: 'ready' },
  completed: { label: 'Выдан', tone: 'done' },
  cancelled: { label: 'Отменён', tone: 'cancel' },
}
