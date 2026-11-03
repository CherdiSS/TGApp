import { useCallback, useEffect, useState } from 'react'
import { api, type Category, type Item, type Me, type Order } from './api'
import { useCart } from './cart'
import { ErrorBox, Loader } from './components/ui'
import { AdminScreen, ItemEditor } from './screens/AdminScreens'
import { CartScreen } from './screens/CartScreen'
import { MenuScreen } from './screens/MenuScreen'
import { OrderScreen, OrdersScreen } from './screens/OrderScreens'

type Route =
  | { name: 'menu' }
  | { name: 'cart' }
  | { name: 'order'; order: Order; from: 'cart' | 'orders' }
  | { name: 'orders' }
  | { name: 'admin' }
  | { name: 'edit'; item: Item | null; categoryId: number; categories: Category[] }

export default function App() {
  const cart = useCart()
  const [route, setRoute] = useState<Route>({ name: 'menu' })
  const [menu, setMenu] = useState<Category[] | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState('')

  const loadMenu = useCallback(() => {
    setError('')
    api.menu()
      .then((m) => {
        setMenu(m)
        cart.sync(m.flatMap((c) => c.items))
      })
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    loadMenu()
    api.me().then(setMe).catch(() => setMe(null))
  }, [loadMenu])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [route.name])

  const toMenu = useCallback(() => setRoute({ name: 'menu' }), [])

  if (error && !menu) return <ErrorBox message={error} onRetry={loadMenu} />
  if (!menu) return <Loader />

  switch (route.name) {
    case 'cart':
      return (
        <CartScreen
          onBack={toMenu}
          onOrdered={(order) => setRoute({ name: 'order', order, from: 'cart' })}
          onMenuChanged={loadMenu}
        />
      )
    case 'order':
      return (
        <OrderScreen
          key={route.order.id}
          initial={route.order}
          onBack={() => setRoute(route.from === 'orders' ? { name: 'orders' } : { name: 'menu' })}
          onMenu={toMenu}
        />
      )
    case 'orders':
      return <OrdersScreen onBack={toMenu} onOpen={(order) => setRoute({ name: 'order', order, from: 'orders' })} />
    case 'admin':
      return (
        <AdminScreen
          onBack={() => { loadMenu(); toMenu() }}
          onEdit={(item, categoryId, categories) => setRoute({ name: 'edit', item, categoryId, categories })}
        />
      )
    case 'edit':
      return <ItemEditor {...route} key={route.item?.id ?? 'new'} onDone={() => setRoute({ name: 'admin' })} />
    default:
      return (
        <MenuScreen
          menu={menu}
          isAdmin={Boolean(me?.is_admin)}
          onCart={() => setRoute({ name: 'cart' })}
          onOrders={() => setRoute({ name: 'orders' })}
          onAdmin={() => setRoute({ name: 'admin' })}
        />
      )
  }
}
