"""Точка входа: FastAPI + бот (long polling) в одном процессе.

Запуск:  uvicorn app.main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import router
from .config import settings
from .db import Database

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("cafe")


def _on_polling_done(task: asyncio.Task) -> None:
    if not task.cancelled() and task.exception():
        log.error("Бот остановился с ошибкой", exc_info=task.exception())


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    db = Database(settings.db_path)
    await db.connect()
    app.state.db = db

    bot = None
    polling: asyncio.Task | None = None
    if settings.bot_token and settings.run_bot:
        from .bot import CafeBot

        bot = CafeBot(settings.bot_token, db)
        app.state.notifier = bot
        polling = asyncio.create_task(bot.run_polling())
        polling.add_done_callback(_on_polling_done)
        log.info("Бот запущен (long polling)")
    else:
        log.warning("Бот не запущен: нет BOT_TOKEN или DISABLE_BOT=1")
    if settings.dev_mode:
        log.warning("DEV_MODE включён: запросы без initData принимаются от тестового юзера")

    try:
        yield
    finally:
        if polling:
            polling.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await polling
        if bot:
            await bot.close()
        await db.close()


app = FastAPI(title="Cafe Mini App API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
)
app.include_router(router)
