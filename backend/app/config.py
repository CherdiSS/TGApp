"""Настройки приложения из переменных окружения (.env)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _ids(raw: str | None) -> set[int]:
    if not raw:
        return set()
    return {int(x) for x in raw.replace(" ", "").split(",") if x}


def _bool(raw: str | None) -> bool:
    return (raw or "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    bot_token: str = field(default_factory=lambda: os.getenv("BOT_TOKEN", ""))
    # Куда бот присылает новые заказы: личка владельца или группа сотрудников.
    owner_chat_id: int | None = field(
        default_factory=lambda: int(v) if (v := os.getenv("OWNER_CHAT_ID")) else None
    )
    # Telegram ID пользователей, которым доступна админка меню.
    admin_ids: set[int] = field(default_factory=lambda: _ids(os.getenv("ADMIN_IDS")))
    # HTTPS-адрес фронтенда — открывается кнопкой в боте.
    webapp_url: str = field(default_factory=lambda: os.getenv("WEBAPP_URL", ""))
    # Разрешённые origin'ы для CORS (через запятую).
    cors_origins: list[str] = field(
        default_factory=lambda: [
            o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()
        ]
    )
    db_path: Path = field(
        default_factory=lambda: Path(os.getenv("DB_PATH", "data/cafe.db"))
    )
    # Сколько секунд initData считается свежей.
    init_data_ttl: int = field(
        default_factory=lambda: int(os.getenv("INIT_DATA_TTL", str(24 * 3600)))
    )
    # Режим разработки: можно открыть приложение в обычном браузере без Telegram.
    # НИКОГДА не включайте на проде.
    dev_mode: bool = field(default_factory=lambda: _bool(os.getenv("DEV_MODE")))
    # Запускать ли бота (long polling) вместе с API.
    run_bot: bool = field(default_factory=lambda: not _bool(os.getenv("DISABLE_BOT")))


settings = Settings()
