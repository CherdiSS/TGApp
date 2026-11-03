import { useEffect, useRef } from 'react'
import { inTelegram, tg } from '../telegram'

interface MainButtonProps {
  text: string
  onClick: () => void
  disabled?: boolean
  progress?: boolean
  /** Вторичная подпись справа (сумма). В Telegram склеивается с текстом. */
  aside?: string
}

/**
 * Нативная MainButton Telegram. Вне Telegram рисуем такую же кнопку внизу экрана,
 * чтобы приложение можно было показать в обычном браузере.
 */
export function MainButton({ text, onClick, disabled, progress, aside }: MainButtonProps) {
  const cb = useRef(onClick)
  cb.current = onClick

  useEffect(() => {
    if (!inTelegram || !tg) return
    const btn = tg.MainButton
    const handler = () => cb.current()
    btn.onClick(handler)
    return () => {
      btn.offClick(handler)
      btn.hideProgress()
      btn.hide()
    }
  }, [])

  useEffect(() => {
    if (!inTelegram || !tg) return
    tg.MainButton.setParams({
      text: aside ? `${text} · ${aside}` : text,
      is_active: !disabled && !progress,
      is_visible: true,
    })
    if (progress) tg.MainButton.showProgress(false)
    else tg.MainButton.hideProgress()
  }, [text, aside, disabled, progress])

  if (inTelegram) return null
  return (
    <div className="fallback-main">
      <button className="fallback-main__btn" disabled={disabled || progress} onClick={onClick}>
        {progress ? <span className="spinner" /> : (
          <>
            <span>{text}</span>
            {aside && <span className="fallback-main__aside">{aside}</span>}
          </>
        )}
      </button>
    </div>
  )
}

/** Нативная BackButton Telegram; в браузере — стрелка в шапке экрана. */
export function BackButton({ onClick }: { onClick: () => void }) {
  const cb = useRef(onClick)
  cb.current = onClick

  useEffect(() => {
    if (!inTelegram || !tg) return
    const btn = tg.BackButton
    const handler = () => cb.current()
    btn.onClick(handler)
    btn.show()
    return () => {
      btn.offClick(handler)
      btn.hide()
    }
  }, [])

  if (inTelegram) return null
  return (
    <button className="fallback-back" onClick={onClick} aria-label="Назад">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
    </button>
  )
}
