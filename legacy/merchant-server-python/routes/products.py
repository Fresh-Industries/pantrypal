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

"""Product catalog routes for the UCP server."""

from typing import Annotated

import db
import dependencies
from fastapi import APIRouter
from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter()


@router.get("/products", summary="List products")
async def list_products(
  products_session: Annotated[AsyncSession, Depends(dependencies.get_products_db)]
) -> dict[str, list[dict[str, object]]]:
  """Return catalog products for agent discovery/mapping."""
  products = await db.list_products(products_session)
  has_inventory = await db.products_have_inventory_column(products_session)

  response = []
  for product in products:
    item = {
      "id": product.id,
      "title": product.title,
      "price": product.price,
      "image_url": product.image_url,
    }
    if has_inventory:
      item["inventory_quantity"] = await db.get_product_inventory_quantity(
        products_session, product.id
      )
    response.append(item)

  return {"products": response}
