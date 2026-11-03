"""Telegram-бот: приветствие с кнопкой Mini App, заказы владельцу, статусы клиенту."""
from __future__ import annotations

import logging
from html import escape
from typing import Any

from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramAPIError
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    MenuButtonWebApp,
    Message,
    WebAppInfo,
)

from .config import settings
from .db import Database

log = logging.getLogger(__name__)

STATUS_LABELS = {
    "new": "🆕 Новый",
    "accepted": "👨‍🍳 Готовится",
    "ready": "🍽 Готов к выдаче",
    "completed": "✅ Выдан",
    "cancelled": "❌ Отменён",
}

# Из каких статусов можно перейти в данный.
TRANSITIONS: dict[str, set[str]] = {
    "accepted": {"new"},
    "ready": {"accepted"},
    "completed": {"ready"},
    "cancelled": {"new", "accepted"},
}

CUSTOMER_TEXTS = {
    "new": "🧾 Заказ <b>№{id}</b> отправлен в кафе. Как только его примут — я напишу.",
    "accepted": "👨‍🍳 Заказ <b>№{id}</b> принят и уже готовится!",
    "ready": "🍽 Заказ <b>№{id}</b> готов — можно забирать!",
    "completed": "💛 Спасибо за заказ <b>№{id}</b>! Приятного аппетита.",
    "cancelled": "❌ К сожалению, заказ <b>№{id}</b> отменён. Если есть вопросы — просто "
                 "ответьте на это сообщение.",
}


def rub(value: int) -> str:
    return f"{value:,}".replace(",", " ") + " ₽"


def owner_keyboard(order: dict[str, Any]) -> InlineKeyboardMarkup | None:
    oid, st = order["id"], order["status"]
    rows: list[list[InlineKeyboardButton]] = []
    if st == "new":
        rows.append([
            InlineKeyboardButton(text="✅ Принят", callback_data=f"order:{oid}:accepted"),
            InlineKeyboardButton(text="❌ Отменить", callback_data=f"order:{oid}:cancelled"),
        ])
    elif st == "accepted":
        rows.append([
            InlineKeyboardButton(text="🍽 Готов", callback_data=f"order:{oid}:ready"),
            InlineKeyboardButton(text="❌ Отменить", callback_data=f"order:{oid}:cancelled"),
        ])
    elif st == "ready":
        rows.append([
            InlineKeyboardButton(text="🤝 Выдан", callback_data=f"order:{oid}:completed"),
        ])
    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else None


def format_order_for_owner(order: dict[str, Any]) -> str:
    customer = escape(order["user_name"])
    if order.get("username"):
        customer += f" (@{escape(order['username'])})"
    else:
        customer = f'<a href="tg://user?id={order["user_id"]}">{customer}</a>'

    lines = [
        f"<b>Заказ №{order['id']}</b> · {STATUS_LABELS.get(order['status'], order['status'])}",
        "",
        f"👤 {customer}",
    ]
    if order.get("pickup_time"):
        lines.append(f"🕒 Забрать: <b>{escape(order['pickup_time'])}</b>")
    lines.append("")
    for it in order["items"]:
        lines.append(f"• {escape(it['name'])} × {it['qty']} — {rub(it['price'] * it['qty'])}")
    lines += ["", f"<b>Итого: {rub(order['total'])}</b>"]
    if order.get("comment"):
        lines += ["", f"💬 <i>{escape(order['comment'])}</i>"]
    return "\n".join(lines)


def webapp_keyboard() -> InlineKeyboardMarkup | None:
    if not settings.webapp_url:
        return None
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="🍽 Открыть меню", web_app=WebAppInfo(url=settings.webapp_url))
    ]])


class CafeBot:
    def __init__(self, token: str, db: Database):
        self.db = db
        self.bot = Bot(token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
        self.dp = Dispatcher()
        self.dp.include_router(self._router())

    # ---------- хендлеры ----------

    def _router(self) -> Router:
        r = Router()

        @r.message(CommandStart())
        async def start(m: Message) -> None:
            await m.answer(
                "👋 Привет! Это демо-кафе в Telegram.\n\n"
                "Откройте меню, соберите заказ — и я пришлю уведомление, "
                "когда он будет готов.",
                reply_markup=webapp_keyboard(),
            )

        @r.message(Command("id"))
        async def my_id(m: Message) -> None:
            # Удобно при настройке OWNER_CHAT_ID / ADMIN_IDS.
            await m.answer(f"chat_id: <code>{m.chat.id}</code>\nuser_id: <code>{m.from_user.id}</code>")

        @r.callback_query(F.data.startswith("order:"))
        async def on_status(cb: CallbackQuery) -> None:
            await self._handle_status_callback(cb)

        return r

    def _can_manage(self, cb: CallbackQuery) -> bool:
        if cb.from_user.id in settings.admin_ids:
            return True
        # Если заказы приходят в группу сотрудников — доверяем её участникам.
        chat_id = cb.message.chat.id if cb.message else None
        return settings.owner_chat_id is not None and chat_id == settings.owner_chat_id

    async def _handle_status_callback(self, cb: CallbackQuery) -> None:
        try:
            _, raw_id, new_status = (cb.data or "").split(":")
            order_id = int(raw_id)
        except ValueError:
            await cb.answer("Некорректная кнопка", show_alert=True)
            return

        if not self._can_manage(cb):
            await cb.answer("Нет доступа", show_alert=True)
            return
        if new_status not in TRANSITIONS:
            await cb.answer("Неизвестный статус", show_alert=True)
            return

        order = await self.db.set_status(order_id, new_status, TRANSITIONS[new_status])
        if order is None:
            current = await self.db.get_order(order_id)
            await cb.answer("Статус уже изменён", show_alert=False)
            if current and cb.message:
                await self._refresh_owner_message(current)
            return

        await cb.answer(STATUS_LABELS[new_status])
        await self._refresh_owner_message(order)
        await self.notify_customer(order)

    # ---------- уведомления ----------

    async def notify_new_order(self, order: dict[str, Any]) -> None:
        if settings.owner_chat_id is None:
            log.warning("OWNER_CHAT_ID не задан — заказ №%s никому не отправлен", order["id"])
        else:
            try:
                msg = await self.bot.send_message(
                    settings.owner_chat_id,
                    format_order_for_owner(order),
                    reply_markup=owner_keyboard(order),
                )
                await self.db.set_owner_message(order["id"], msg.chat.id, msg.message_id)
            except TelegramAPIError:
                log.exception("Не удалось отправить заказ №%s владельцу", order["id"])
        await self.notify_customer(order)

    async def notify_customer(self, order: dict[str, Any]) -> None:
        text = CUSTOMER_TEXTS.get(order["status"])
        if not text:
            return
        try:
            await self.bot.send_message(order["user_id"], text.format(id=order["id"]))
        except TelegramAPIError as e:
            # Пользователь не запускал бота или заблокировал его — это не ошибка заказа.
            log.info("Не удалось уведомить пользователя %s: %s", order["user_id"], e)

    async def _refresh_owner_message(self, order: dict[str, Any]) -> None:
        if not order.get("owner_chat_id") or not order.get("owner_message_id"):
            return
        try:
            await self.bot.edit_message_text(
                chat_id=order["owner_chat_id"],
                message_id=order["owner_message_id"],
                text=format_order_for_owner(order),
                reply_markup=owner_keyboard(order),
            )
        except TelegramAPIError as e:
            log.debug("edit_message_text: %s", e)

    # ---------- запуск ----------

    async def setup(self) -> None:
        if settings.webapp_url:
            await self.bot.set_chat_menu_button(
                menu_button=MenuButtonWebApp(text="Меню", web_app=WebAppInfo(url=settings.webapp_url))
            )

    async def run_polling(self) -> None:
        await self.setup()
        await self.bot.delete_webhook(drop_pending_updates=False)
        await self.dp.start_polling(self.bot, handle_signals=False)

    async def close(self) -> None:
        await self.bot.session.close()
