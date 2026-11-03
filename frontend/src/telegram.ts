// Тонкая обёртка над window.Telegram.WebApp (скрипт telegram-web-app.js в index.html).
// Вне Telegram (обычный браузер) всё деградирует мягко, чтобы приложение можно было
// показать и отладить на компьютере.

type HapticImpact = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'
type HapticNotice = 'error' | 'success' | 'warning'

interface BottomButton {
  setParams(p: {
    text?: string
    color?: string
    text_color?: string
    is_active?: boolean
    is_visible?: boolean
    has_shine_effect?: boolean
  }): void
  onClick(cb: () => void): void
  offClick(cb: () => void): void
  showProgress(leaveActive?: boolean): void
  hideProgress(): void
  show(): void
  hide(): void
}

interface WebApp {
  initData: string
  initDataUnsafe: {
    user?: {
      id: number
      first_name: string
      last_name?: string
      username?: string
      allows_write_to_pm?: boolean
    }
  }
  version: string
  platform: string
  colorScheme: 'light' | 'dark'
  isVersionAtLeast(v: string): boolean
  ready(): void
  expand(): void
  close(): void
  setHeaderColor(color: string): void
  setBackgroundColor(color: string): void
  setBottomBarColor?(color: string): void
  enableClosingConfirmation(): void
  disableClosingConfirmation(): void
  disableVerticalSwipes?(): void
  showAlert(message: string, cb?: () => void): void
  showConfirm(message: string, cb: (ok: boolean) => void): void
  requestWriteAccess(cb?: (granted: boolean) => void): void
  onEvent(event: string, cb: () => void): void
  offEvent(event: string, cb: () => void): void
  MainButton: BottomButton
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void }
  HapticFeedback: {
    impactOccurred(style: HapticImpact): void
    notificationOccurred(type: HapticNotice): void
    selectionChanged(): void
  }
}

declare global {
  interface Window {
    Telegram?: { WebApp: WebApp }
  }
}

export const tg: WebApp | undefined = window.Telegram?.WebApp
/** Открыто ли приложение действительно внутри Telegram (есть подписанные initData). */
export const inTelegram = Boolean(tg?.initData)

const atLeast = (v: string) => Boolean(tg && inTelegram && tg.isVersionAtLeast(v))

export function initTelegram() {
  if (!tg || !inTelegram) {
    document.documentElement.dataset.standalone = 'true'
    return
  }
  tg.ready()
  tg.expand()
  if (atLeast('6.1')) {
    tg.setHeaderColor('secondary_bg_color')
    tg.setBackgroundColor('secondary_bg_color' as string)
  }
  if (atLeast('7.10')) tg.setBottomBarColor?.('secondary_bg_color')
  // Чтобы свайп вниз по списку не закрывал приложение.
  if (atLeast('7.7')) tg.disableVerticalSwipes?.()
}

export const haptic = {
  tap: () => atLeast('6.1') && tg!.HapticFeedback.impactOccurred('light'),
  select: () => atLeast('6.1') && tg!.HapticFeedback.selectionChanged(),
  success: () => atLeast('6.1') && tg!.HapticFeedback.notificationOccurred('success'),
  error: () => atLeast('6.1') && tg!.HapticFeedback.notificationOccurred('error'),
}

export function showAlert(message: string): Promise<void> {
  return new Promise((resolve) => {
    if (atLeast('6.2')) tg!.showAlert(message, resolve)
    else {
      window.alert(message)
      resolve()
    }
  })
}

export function showConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (atLeast('6.2')) tg!.showConfirm(message, resolve)
    else resolve(window.confirm(message))
  })
}

/** Просим разрешение писать в личку, чтобы бот смог прислать статус заказа. */
export function ensureWriteAccess(): Promise<boolean> {
  return new Promise((resolve) => {
    const user = tg?.initDataUnsafe.user
    if (!user || user.allows_write_to_pm !== false || !atLeast('6.9')) return resolve(true)
    tg!.requestWriteAccess((granted) => resolve(granted))
  })
}

export function setClosingConfirmation(enabled: boolean) {
  if (!atLeast('6.2')) return
  if (enabled) tg!.enableClosingConfirmation()
  else tg!.disableClosingConfirmation()
}

export const tgUser = tg?.initDataUnsafe.user
