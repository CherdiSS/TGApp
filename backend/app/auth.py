"""Проверка подписи initData, которую Telegram передаёт в Mini App.

Алгоритм из документации:
https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

    secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
    data_check_string = "\n".join(sorted(f"{k}={v}" for всех полей, кроме hash))
    valid = hex(HMAC_SHA256(key=secret_key, msg=data_check_string)) == hash

Без этой проверки любой может отправить запрос от имени любого пользователя.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from urllib.parse import parse_qsl

from fastapi import Depends, Header, HTTPException, status

from .config import settings


class InitDataError(ValueError):
    pass


@dataclass(frozen=True)
class TgUser:
    id: int
    first_name: str
    last_name: str | None = None
    username: str | None = None
    language_code: str | None = None
    allows_write_to_pm: bool | None = None

    @property
    def full_name(self) -> str:
        return " ".join(p for p in (self.first_name, self.last_name) if p)


def validate_init_data(
    init_data: str, bot_token: str, max_age: int | None = 24 * 3600, now: float | None = None
) -> dict:
    """Проверяет подпись и свежесть initData. Возвращает распарсенные поля."""
    if not init_data:
        raise InitDataError("initData is empty")
    if not bot_token:
        raise InitDataError("BOT_TOKEN is not configured")

    pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=True)
    data = dict(pairs)
    received_hash = data.pop("hash", None)
    if not received_hash:
        raise InitDataError("hash is missing")

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    calculated = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(calculated, received_hash):
        raise InitDataError("invalid signature")

    if max_age is not None:
        try:
            auth_date = int(data.get("auth_date", "0"))
        except ValueError as e:
            raise InitDataError("bad auth_date") from e
        if (now or time.time()) - auth_date > max_age:
            raise InitDataError("initData is expired")

    if "user" in data:
        data["user"] = json.loads(data["user"])
    return data


def _user_from_dict(u: dict) -> TgUser:
    return TgUser(
        id=int(u["id"]),
        first_name=u.get("first_name", ""),
        last_name=u.get("last_name"),
        username=u.get("username"),
        language_code=u.get("language_code"),
        allows_write_to_pm=u.get("allows_write_to_pm"),
    )


DEV_USER = TgUser(id=1, first_name="Demo", last_name="User", username="demo")


async def current_user(
    authorization: str | None = Header(default=None),
) -> TgUser:
    """FastAPI-зависимость: пользователь из заголовка `Authorization: tma <initData>`."""
    raw = ""
    if authorization and authorization.lower().startswith("tma "):
        raw = authorization[4:].strip()

    if not raw:
        if settings.dev_mode:
            return DEV_USER
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Откройте приложение из Telegram")

    try:
        data = validate_init_data(raw, settings.bot_token, settings.init_data_ttl)
    except InitDataError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"initData: {e}") from e

    if "user" not in data:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "initData: no user")
    return _user_from_dict(data["user"])


def is_admin(user: TgUser) -> bool:
    if settings.dev_mode and user.id == DEV_USER.id:
        return True
    return user.id in settings.admin_ids


async def admin_user(user: TgUser = Depends(current_user)) -> TgUser:
    if not is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Только для администратора")
    return user
