#   Copyright 2026 UCP Authors
#
#   Licensed under the Apache License, Version 2.0 (the "License");
#   you may not use this file except in compliance with the License.
#   You may obtain a copy of the License at
#
#       http://www.apache.org/licenses/LICENSE-2.0
#
#   Unless required by applicable law or agreed to in writing, software
#   distributed under the License is distributed on an "AS IS" BASIS,
#   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#   See the License for the specific language governing permissions and
#   limitations under the License.

"""Agent state persistence routes for the Dish Feed prototype."""

import datetime
import enum
import uuid
from typing import Any, Annotated

import db
import dependencies
from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter()


class AgentRunState(str, enum.Enum):
  """Agent run state enum."""

  DISCOVER_MERCHANT = "DISCOVER_MERCHANT"
  CHECK_CAPABILITIES = "CHECK_CAPABILITIES"
  RESOLVE_INGREDIENTS = "RESOLVE_INGREDIENTS"
  BUILD_CART_DRAFT = "BUILD_CART_DRAFT"
  QUOTE_CART = "QUOTE_CART"
  AWAITING_APPROVAL = "AWAITING_APPROVAL"
  CHECKOUT = "CHECKOUT"
  ORDER_CREATED = "ORDER_CREATED"
  ORDER_TRACKING = "ORDER_TRACKING"
  FAILED = "FAILED"


def _now_iso() -> str:
  return datetime.datetime.now(datetime.timezone.utc).isoformat()


class AgentRunPayload(BaseModel):
  """Agent run payload."""

  model_config = ConfigDict(populate_by_name=True)

  id: str | None = None
  user_id: str | None = Field(default=None, alias="userId")
  device_id: str | None = Field(default=None, alias="deviceId")
  recipe_id: str | None = Field(default=None, alias="recipeId")
  merchant_base_url: str | None = Field(default=None, alias="merchantBaseUrl")
  store_id: str | None = Field(default=None, alias="storeId")
  created_at: str | None = Field(default=None, alias="createdAt")
  updated_at: str | None = Field(default=None, alias="updatedAt")
  state: AgentRunState | None = None
  failure_code: str | None = Field(default=None, alias="failureCode")
  failure_detail: str | None = Field(default=None, alias="failureDetail")
  cart_draft_id: str | None = Field(default=None, alias="cartDraftId")
  order_id: str | None = Field(default=None, alias="orderId")


class AgentRunStepLogPayload(BaseModel):
  """Agent run step log payload."""

  model_config = ConfigDict(populate_by_name=True)

  id: str | None = None
  agent_run_id: str = Field(alias="agentRunId")
  step_name: str = Field(alias="stepName")
  request_id: str | None = Field(default=None, alias="requestId")
  idempotency_key: str | None = Field(default=None, alias="idempotencyKey")
  started_at: str | None = Field(default=None, alias="startedAt")
  finished_at: str | None = Field(default=None, alias="finishedAt")
  duration_ms: int | None = Field(default=None, alias="durationMs")
  success: bool = False
  error_summary: str | None = Field(default=None, alias="errorSummary")


class CartDraftPayload(BaseModel):
  """Cart draft payload."""

  model_config = ConfigDict(populate_by_name=True)

  id: str | None = None
  agent_run_id: str | None = Field(default=None, alias="agentRunId")
  recipe_id: str | None = Field(default=None, alias="recipeId")
  servings: int | None = None
  pantry_items_removed: Any | None = Field(
    default=None, alias="pantryItemsRemoved"
  )
  policies: Any | None = None
  quote_summary: Any | None = Field(default=None, alias="quoteSummary")
  checkout_session_id: str | None = Field(
    default=None, alias="checkoutSessionId"
  )
  cart_hash: str | None = Field(default=None, alias="cartHash")
  quote_hash: str | None = Field(default=None, alias="quoteHash")
  created_at: str | None = Field(default=None, alias="createdAt")
  updated_at: str | None = Field(default=None, alias="updatedAt")


class CartDraftAlternativePayload(BaseModel):
  """Cart draft alternative payload."""

  model_config = ConfigDict(populate_by_name=True)

  id: str | None = None
  rank: int
  sku_json: Any | None = Field(default=None, alias="skuJson")
  score_breakdown_json: Any | None = Field(
    default=None, alias="scoreBreakdownJson"
  )
  reason: str | None = None
  confidence: float | None = None


class CartDraftLineItemPayload(BaseModel):
  """Cart draft line item payload."""

  model_config = ConfigDict(populate_by_name=True)

  id: str | None = None
  ingredient_key: str = Field(alias="ingredientKey")
  canonical_ingredient_json: Any | None = Field(
    default=None, alias="canonicalIngredientJson"
  )
  primary_sku_json: Any | None = Field(default=None, alias="primarySkuJson")
  quantity: float
  unit: str | None = None
  confidence: float | None = None
  chosen_reason: str | None = Field(default=None, alias="chosenReason")
  substitution_policy_json: Any | None = Field(
    default=None, alias="substitutionPolicyJson"
  )
  line_total_cents: int | None = Field(default=None, alias="lineTotalCents")
  alternatives: list[CartDraftAlternativePayload] = []


class CartDraftUpsertPayload(BaseModel):
  """Cart draft upsert payload."""

  model_config = ConfigDict(populate_by_name=True)

  cart: CartDraftPayload
  line_items: list[CartDraftLineItemPayload] = Field(
    default_factory=list, alias="lineItems"
  )


class ApprovalPayload(BaseModel):
  """Approval payload."""

  model_config = ConfigDict(populate_by_name=True)

  id: str | None = None
  agent_run_id: str = Field(alias="agentRunId")
  cart_hash: str = Field(alias="cartHash")
  quote_hash: str = Field(alias="quoteHash")
  approved_total_cents: int | None = Field(
    default=None, alias="approvedTotalCents"
  )
  approved_at: str | None = Field(default=None, alias="approvedAt")
  signature_mock: str | None = Field(default=None, alias="signatureMock")
  status: str


def _serialize_agent_run(agent_run: db.AgentRun) -> dict[str, Any]:
  return {
    "id": agent_run.id,
    "userId": agent_run.user_id,
    "deviceId": agent_run.device_id,
    "recipeId": agent_run.recipe_id,
    "merchantBaseUrl": agent_run.merchant_base_url,
    "storeId": agent_run.store_id,
    "createdAt": agent_run.created_at,
    "updatedAt": agent_run.updated_at,
    "state": agent_run.state,
    "failureCode": agent_run.failure_code,
    "failureDetail": agent_run.failure_detail,
    "cartDraftId": agent_run.cart_draft_id,
    "orderId": agent_run.order_id,
  }


def _serialize_step_log(step_log: db.AgentRunStepLog) -> dict[str, Any]:
  return {
    "id": step_log.id,
    "agentRunId": step_log.agent_run_id,
    "stepName": step_log.step_name,
    "requestId": step_log.request_id,
    "idempotencyKey": step_log.idempotency_key,
    "startedAt": step_log.started_at,
    "finishedAt": step_log.finished_at,
    "durationMs": step_log.duration_ms,
    "success": step_log.success,
    "errorSummary": step_log.error_summary,
  }


def _serialize_cart_draft(cart_draft: db.CartDraft) -> dict[str, Any]:
  return {
    "id": cart_draft.id,
    "agentRunId": cart_draft.agent_run_id,
    "recipeId": cart_draft.recipe_id,
    "servings": cart_draft.servings,
    "pantryItemsRemoved": cart_draft.pantry_items_removed,
    "policies": cart_draft.policies,
    "quoteSummary": cart_draft.quote_summary,
    "checkoutSessionId": cart_draft.checkout_session_id,
    "cartHash": cart_draft.cart_hash,
    "quoteHash": cart_draft.quote_hash,
    "createdAt": cart_draft.created_at,
    "updatedAt": cart_draft.updated_at,
  }


def _serialize_cart_line_item(
  line_item: db.CartDraftLineItem,
  alternatives: list[db.CartDraftAlternative],
) -> dict[str, Any]:
  return {
    "id": line_item.id,
    "cartDraftId": line_item.cart_draft_id,
    "ingredientKey": line_item.ingredient_key,
    "canonicalIngredientJson": line_item.canonical_ingredient_json,
    "primarySkuJson": line_item.primary_sku_json,
    "quantity": line_item.quantity,
    "unit": line_item.unit,
    "confidence": line_item.confidence,
    "chosenReason": line_item.chosen_reason,
    "substitutionPolicyJson": line_item.substitution_policy_json,
    "lineTotalCents": line_item.line_total_cents,
    "alternatives": [
      {
        "id": alt.id,
        "lineItemId": alt.line_item_id,
        "rank": alt.rank,
        "skuJson": alt.sku_json,
        "scoreBreakdownJson": alt.score_breakdown_json,
        "reason": alt.reason,
        "confidence": alt.confidence,
      }
      for alt in alternatives
    ],
  }


def _serialize_approval(approval: db.Approval) -> dict[str, Any]:
  return {
    "id": approval.id,
    "agentRunId": approval.agent_run_id,
    "cartHash": approval.cart_hash,
    "quoteHash": approval.quote_hash,
    "approvedTotalCents": approval.approved_total_cents,
    "approvedAt": approval.approved_at,
    "signatureMock": approval.signature_mock,
    "status": approval.status,
  }


async def _replace_cart_line_items(
  session: AsyncSession,
  cart_draft_id: str,
  line_items: list[CartDraftLineItemPayload],
) -> list[db.CartDraftLineItem]:
  existing_items = await db.get_cart_draft_line_items(session, cart_draft_id)
  existing_ids = [item.id for item in existing_items]
  if existing_ids:
    await session.execute(
      db.CartDraftAlternative.__table__.delete().where(
        db.CartDraftAlternative.line_item_id.in_(existing_ids)
      )
    )
  await db.delete_cart_draft_line_items(session, cart_draft_id)

  persisted: list[db.CartDraftLineItem] = []
  for line in line_items:
    line_id = line.id or str(uuid.uuid4())
    record = db.CartDraftLineItem(
      id=line_id,
      cart_draft_id=cart_draft_id,
      ingredient_key=line.ingredient_key,
      canonical_ingredient_json=line.canonical_ingredient_json,
      primary_sku_json=line.primary_sku_json,
      quantity=line.quantity,
      unit=line.unit,
      confidence=line.confidence,
      chosen_reason=line.chosen_reason,
      substitution_policy_json=line.substitution_policy_json,
      line_total_cents=line.line_total_cents,
    )
    session.add(record)
    persisted.append(record)

    for alt in line.alternatives:
      alt_id = alt.id or str(uuid.uuid4())
      session.add(
        db.CartDraftAlternative(
          id=alt_id,
          line_item_id=line_id,
          rank=alt.rank,
          sku_json=alt.sku_json,
          score_breakdown_json=alt.score_breakdown_json,
          reason=alt.reason,
          confidence=alt.confidence,
        )
      )
  return persisted


@router.post("/agent-runs")
async def upsert_agent_run(
  payload: AgentRunPayload,
  session: Annotated[
    AsyncSession, Depends(dependencies.get_transactions_db)
  ],
) -> dict[str, Any]:
  agent_run_id = payload.id or str(uuid.uuid4())
  existing = await db.get_agent_run(session, agent_run_id)
  now_iso = _now_iso()

  if existing:
    if payload.user_id is not None:
      existing.user_id = payload.user_id
    if payload.device_id is not None:
      existing.device_id = payload.device_id
    if payload.recipe_id is not None:
      existing.recipe_id = payload.recipe_id
    if payload.merchant_base_url is not None:
      existing.merchant_base_url = payload.merchant_base_url
    if payload.store_id is not None:
      existing.store_id = payload.store_id
    if payload.state is not None:
      existing.state = payload.state.value
    if payload.failure_code is not None:
      existing.failure_code = payload.failure_code
    if payload.failure_detail is not None:
      existing.failure_detail = payload.failure_detail
    if payload.cart_draft_id is not None:
      existing.cart_draft_id = payload.cart_draft_id
    if payload.order_id is not None:
      existing.order_id = payload.order_id
    existing.updated_at = payload.updated_at or now_iso
    await session.commit()
    await session.refresh(existing)
    return {"agentRun": _serialize_agent_run(existing)}

  agent_run = db.AgentRun(
    id=agent_run_id,
    user_id=payload.user_id,
    device_id=payload.device_id,
    recipe_id=payload.recipe_id,
    merchant_base_url=payload.merchant_base_url,
    store_id=payload.store_id,
    created_at=payload.created_at or now_iso,
    updated_at=payload.updated_at or now_iso,
    state=payload.state.value if payload.state else AgentRunState.DISCOVER_MERCHANT.value,
    failure_code=payload.failure_code,
    failure_detail=payload.failure_detail,
    cart_draft_id=payload.cart_draft_id,
    order_id=payload.order_id,
  )
  session.add(agent_run)
  await session.commit()
  await session.refresh(agent_run)
  return {"agentRun": _serialize_agent_run(agent_run)}


@router.patch("/agent-runs/{id}")
async def update_agent_run(
  agent_run_id: Annotated[str, Path(..., alias="id")],
  payload: AgentRunPayload,
  session: Annotated[
    AsyncSession, Depends(dependencies.get_transactions_db)
  ],
) -> dict[str, Any]:
  existing = await db.get_agent_run(session, agent_run_id)
  if not existing:
    raise HTTPException(status_code=404, detail="Agent run not found.")

  now_iso = _now_iso()
  if payload.user_id is not None:
    existing.user_id = payload.user_id
  if payload.device_id is not None:
    existing.device_id = payload.device_id
  if payload.recipe_id is not None:
    existing.recipe_id = payload.recipe_id
  if payload.merchant_base_url is not None:
    existing.merchant_base_url = payload.merchant_base_url
  if payload.store_id is not None:
    existing.store_id = payload.store_id
  if payload.state is not None:
    existing.state = payload.state.value
  if payload.failure_code is not None:
    existing.failure_code = payload.failure_code
  if payload.failure_detail is not None:
    existing.failure_detail = payload.failure_detail
  if payload.cart_draft_id is not None:
    existing.cart_draft_id = payload.cart_draft_id
  if payload.order_id is not None:
    existing.order_id = payload.order_id
  existing.updated_at = payload.updated_at or now_iso
  await session.commit()
  await session.refresh(existing)
  return {"agentRun": _serialize_agent_run(existing)}


@router.get("/agent-runs/{id}")
async def get_agent_run(
  agent_run_id: Annotated[str, Path(..., alias="id")],
  session: Annotated[
    AsyncSession, Depends(dependencies.get_transactions_db)
  ],
) -> dict[str, Any]:
  agent_run = await db.get_agent_run(session, agent_run_id)
  if not agent_run:
    raise HTTPException(status_code=404, detail="Agent run not found.")
  return {"agentRun": _serialize_agent_run(agent_run)}


@router.post("/agent-run-steps")
async def create_agent_run_step(
  payload: AgentRunStepLogPayload,
  session: Annotated[
    AsyncSession, Depends(dependencies.get_transactions_db)
  ],
) -> dict[str, Any]:
  step_id = payload.id or str(uuid.uuid4())
  started_at = payload.started_at or _now_iso()
  step_log = db.AgentRunStepLog(
    id=step_id,
    agent_run_id=payload.agent_run_id,
    step_name=payload.step_name,
    request_id=payload.request_id,
    idempotency_key=payload.idempotency_key,
    started_at=started_at,
    finished_at=payload.finished_at,
    duration_ms=payload.duration_ms,
    success=payload.success,
    error_summary=payload.error_summary,
  )
  session.add(step_log)
  await session.commit()
  await session.refresh(step_log)
  return {"stepLog": _serialize_step_log(step_log)}


@router.post("/cart-drafts")
async def upsert_cart_draft(
  payload: CartDraftUpsertPayload,
  session: Annotated[
    AsyncSession, Depends(dependencies.get_transactions_db)
  ],
) -> dict[str, Any]:
  cart_payload = payload.cart
  cart_id = cart_payload.id or str(uuid.uuid4())
  existing = await db.get_cart_draft(session, cart_id)
  now_iso = _now_iso()

  if existing:
    if cart_payload.agent_run_id is not None:
      existing.agent_run_id = cart_payload.agent_run_id
    if cart_payload.recipe_id is not None:
      existing.recipe_id = cart_payload.recipe_id
    if cart_payload.servings is not None:
      existing.servings = cart_payload.servings
    if cart_payload.pantry_items_removed is not None:
      existing.pantry_items_removed = cart_payload.pantry_items_removed
    if cart_payload.policies is not None:
      existing.policies = cart_payload.policies
    if cart_payload.quote_summary is not None:
      existing.quote_summary = cart_payload.quote_summary
    if cart_payload.checkout_session_id is not None:
      existing.checkout_session_id = cart_payload.checkout_session_id
    if cart_payload.cart_hash is not None:
      existing.cart_hash = cart_payload.cart_hash
    if cart_payload.quote_hash is not None:
      existing.quote_hash = cart_payload.quote_hash
    existing.updated_at = cart_payload.updated_at or now_iso
    await _replace_cart_line_items(session, cart_id, payload.line_items)
    await session.commit()
    await session.refresh(existing)
  else:
    cart = db.CartDraft(
      id=cart_id,
      agent_run_id=cart_payload.agent_run_id,
      recipe_id=cart_payload.recipe_id,
      servings=cart_payload.servings,
      pantry_items_removed=cart_payload.pantry_items_removed,
      policies=cart_payload.policies,
      quote_summary=cart_payload.quote_summary,
      checkout_session_id=cart_payload.checkout_session_id,
      cart_hash=cart_payload.cart_hash,
      quote_hash=cart_payload.quote_hash,
      created_at=cart_payload.created_at or now_iso,
      updated_at=cart_payload.updated_at or now_iso,
    )
    session.add(cart)
    await session.flush()
    await _replace_cart_line_items(session, cart_id, payload.line_items)
    await session.commit()
    await session.refresh(cart)
    existing = cart

  line_items = await db.get_cart_draft_line_items(session, cart_id)
  alternatives_map: dict[str, list[db.CartDraftAlternative]] = {}
  for line in line_items:
    alternatives_map[line.id] = await db.get_cart_draft_alternatives(
      session, line.id
    )

  return {
    "cart": _serialize_cart_draft(existing),
    "lineItems": [
      _serialize_cart_line_item(line, alternatives_map.get(line.id, []))
      for line in line_items
    ],
  }


@router.patch("/cart-drafts/{id}")
async def update_cart_draft(
  cart_draft_id: Annotated[str, Path(..., alias="id")],
  payload: CartDraftPayload,
  session: Annotated[
    AsyncSession, Depends(dependencies.get_transactions_db)
  ],
) -> dict[str, Any]:
  existing = await db.get_cart_draft(session, cart_draft_id)
  if not existing:
    raise HTTPException(status_code=404, detail="Cart draft not found.")

  now_iso = _now_iso()
  if payload.agent_run_id is not None:
    existing.agent_run_id = payload.agent_run_id
  if payload.recipe_id is not None:
    existing.recipe_id = payload.recipe_id
  if payload.servings is not None:
    existing.servings = payload.servings
  if payload.pantry_items_removed is not None:
    existing.pantry_items_removed = payload.pantry_items_removed
  if payload.policies is not None:
    existing.policies = payload.policies
  if payload.quote_summary is not None:
    existing.quote_summary = payload.quote_summary
  if payload.checkout_session_id is not None:
    existing.checkout_session_id = payload.checkout_session_id
  if payload.cart_hash is not None:
    existing.cart_hash = payload.cart_hash
  if payload.quote_hash is not None:
    existing.quote_hash = payload.quote_hash
  existing.updated_at = payload.updated_at or now_iso
  await session.commit()
  await session.refresh(existing)

  line_items = await db.get_cart_draft_line_items(session, cart_draft_id)
  alternatives_map: dict[str, list[db.CartDraftAlternative]] = {}
  for line in line_items:
    alternatives_map[line.id] = await db.get_cart_draft_alternatives(
      session, line.id
    )

  return {
    "cart": _serialize_cart_draft(existing),
    "lineItems": [
      _serialize_cart_line_item(line, alternatives_map.get(line.id, []))
      for line in line_items
    ],
  }


@router.get("/cart-drafts/{id}")
async def get_cart_draft(
  cart_draft_id: Annotated[str, Path(..., alias="id")],
  session: Annotated[
    AsyncSession, Depends(dependencies.get_transactions_db)
  ],
) -> dict[str, Any]:
  cart = await db.get_cart_draft(session, cart_draft_id)
  if not cart:
    raise HTTPException(status_code=404, detail="Cart draft not found.")

  line_items = await db.get_cart_draft_line_items(session, cart_draft_id)
  alternatives_map: dict[str, list[db.CartDraftAlternative]] = {}
  for line in line_items:
    alternatives_map[line.id] = await db.get_cart_draft_alternatives(
      session, line.id
    )

  return {
    "cart": _serialize_cart_draft(cart),
    "lineItems": [
      _serialize_cart_line_item(line, alternatives_map.get(line.id, []))
      for line in line_items
    ],
  }


@router.post("/approvals")
async def create_approval(
  payload: ApprovalPayload,
  session: Annotated[
    AsyncSession, Depends(dependencies.get_transactions_db)
  ],
) -> dict[str, Any]:
  approval_id = payload.id or str(uuid.uuid4())
  approval = db.Approval(
    id=approval_id,
    agent_run_id=payload.agent_run_id,
    cart_hash=payload.cart_hash,
    quote_hash=payload.quote_hash,
    approved_total_cents=payload.approved_total_cents,
    approved_at=payload.approved_at or _now_iso(),
    signature_mock=payload.signature_mock,
    status=payload.status,
  )
  session.add(approval)
  await session.commit()
  await session.refresh(approval)
  return {"approval": _serialize_approval(approval)}

