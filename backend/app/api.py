"""HTTP API для Mini App."""
from __future__ import annotations

import asyncio
import logging
import sqlite3
from typing import Annotated, Any, Protocol

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator

from .auth import TgUser, admin_user, current_user, is_admin
from .db import Database

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api")

MAX_QTY = 20
MAX_POSITIONS = 30


class Notifier(Protocol):
    async def notify_new_order(self, order: dict[str, Any]) -> None: ...


def get_db(request: Request) -> Database:
    return request.app.state.db


def get_notifier(request: Request) -> Notifier | None:
    return getattr(request.app.state, "notifier", None)


DB = Annotated[Database, Depends(get_db)]
User = Annotated[TgUser, Depends(current_user)]
Admin = Annotated[TgUser, Depends(admin_user)]


# ---------- схемы ----------

class CartLine(BaseModel):
    item_id: int
    qty: int = Field(ge=1, le=MAX_QTY)


class OrderIn(BaseModel):
    items: list[CartLine] = Field(min_length=1, max_length=MAX_POSITIONS)
    comment: str = Field(default="", max_length=500)
    pickup_time: str = Field(default="", max_length=40)

    @field_validator("comment", "pickup_time")
    @classmethod
    def strip(cls, v: str) -> str:
        return v.strip()


class ItemIn(BaseModel):
    category_id: int
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=300)
    price: int = Field(ge=0, le=1_000_000)
    weight: str = Field(default="", max_length=30)
    image_url: str = Field(default="", max_length=500)
    available: bool = True
    sort: int = 0


class ItemPatch(BaseModel):
    category_id: int | None = None
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=300)
    price: int | None = Field(default=None, ge=0, le=1_000_000)
    weight: str | None = Field(default=None, max_length=30)
    image_url: str | None = Field(default=None, max_length=500)
    available: bool | None = None
    sort: int | None = None


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    emoji: str = Field(default="", max_length=8)


class CategoryPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=40)
    emoji: str | None = Field(default=None, max_length=8)


# ---------- публичное ----------

@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/me")
async def me(user: User) -> dict[str, Any]:
    return {"id": user.id, "name": user.full_name, "is_admin": is_admin(user)}


@router.get("/menu")
async def menu(db: DB) -> list[dict[str, Any]]:
    return await db.get_menu()


@router.post("/orders", status_code=status.HTTP_201_CREATED)
async def create_order(
    body: OrderIn,
    user: User,
    db: DB,
    notifier: Annotated[Notifier | None, Depends(get_notifier)],
) -> dict[str, Any]:
    # Склеиваем одинаковые позиции.
    qty: dict[int, int] = {}
    for line in body.items:
        qty[line.item_id] = qty.get(line.item_id, 0) + line.qty

    # Цены и наличие берём ТОЛЬКО из БД — клиенту не доверяем.
    db_items = await db.get_items_by_ids(list(qty))
    lines: list[dict[str, Any]] = []
    for item_id, q in qty.items():
        it = db_items.get(item_id)
        if not it or not it["available"]:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Позиция «{it['name']}» закончилась" if it else "Позиция не найдена",
            )
        lines.append({"item_id": item_id, "name": it["name"], "price": it["price"],
                      "qty": min(q, MAX_QTY)})
    total = sum(line["price"] * line["qty"] for line in lines)

    order = await db.create_order(
        user_id=user.id,
        user_name=user.full_name or "Гость",
        username=user.username,
        items=lines,
        total=total,
        comment=body.comment,
        pickup_time=body.pickup_time,
    )
    if notifier is not None:
        # Не задерживаем ответ клиенту из-за Telegram API.
        task = asyncio.create_task(notifier.notify_new_order(order))
        task.add_done_callback(_log_task_error)
    return _public_order(order)


@router.get("/orders")
async def my_orders(user: User, db: DB) -> list[dict[str, Any]]:
    return [_public_order(o) for o in await db.list_user_orders(user.id)]


@router.get("/orders/{order_id}")
async def get_order(order_id: int, user: User, db: DB) -> dict[str, Any]:
    order = await db.get_order(order_id)
    if not order or order["user_id"] != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Заказ не найден")
    return _public_order(order)


# ---------- админка ----------

@router.get("/admin/menu")
async def admin_menu(_: Admin, db: DB) -> list[dict[str, Any]]:
    return await db.get_menu(include_unavailable=True)


@router.post("/admin/items", status_code=status.HTTP_201_CREATED)
async def admin_create_item(body: ItemIn, _: Admin, db: DB) -> dict[str, Any]:
    try:
        return await db.create_item(body.model_dump())
    except sqlite3.IntegrityError as e:  # несуществующая category_id
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Категория не найдена") from e


@router.patch("/admin/items/{item_id}")
async def admin_update_item(item_id: int, body: ItemPatch, _: Admin, db: DB) -> dict[str, Any]:
    try:
        item = await db.update_item(item_id, body.model_dump(exclude_unset=True))
    except sqlite3.IntegrityError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Категория не найдена") from e
    if not item:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
    return item


@router.delete("/admin/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def admin_delete_item(item_id: int, _: Admin, db: DB) -> None:
    if not await db.delete_item(item_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")


@router.post("/admin/categories", status_code=status.HTTP_201_CREATED)
async def admin_create_category(body: CategoryIn, _: Admin, db: DB) -> dict[str, Any]:
    return await db.create_category(body.name, body.emoji)


@router.patch("/admin/categories/{cat_id}", status_code=status.HTTP_204_NO_CONTENT)
async def admin_update_category(cat_id: int, body: CategoryPatch, _: Admin, db: DB) -> None:
    if not await db.update_category(cat_id, body.name, body.emoji):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Категория не найдена")


@router.delete("/admin/categories/{cat_id}", status_code=status.HTTP_204_NO_CONTENT)
async def admin_delete_category(cat_id: int, _: Admin, db: DB) -> None:
    if not await db.delete_category(cat_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Категория не найдена")


# ---------- helpers ----------

def _public_order(o: dict[str, Any]) -> dict[str, Any]:
    keys = ("id", "items", "total", "comment", "pickup_time", "status", "created_at",
            "updated_at")
    return {k: o[k] for k in keys}


def _log_task_error(task: asyncio.Task) -> None:
    if not task.cancelled() and task.exception():
        log.error("Ошибка уведомления о заказе", exc_info=task.exception())
