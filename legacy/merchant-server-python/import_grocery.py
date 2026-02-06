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

"""Create a grocery products database for the Dish Feed prototype.

Usage:
  uv run import_grocery.py --products_db_path=products.db
"""

import sqlite3
from pathlib import Path
from absl import app as absl_app
from absl import flags

FLAGS = flags.FLAGS
flags.DEFINE_string("products_db_path", "products.db", "Path to products DB")

GROCERY_ITEMS = [
  {"id": "milk", "title": "Whole Milk", "price": 399, "inventory": 100},
  {"id": "eggs", "title": "Free Range Eggs", "price": 449, "inventory": 100},
  {"id": "pasta", "title": "Spaghetti Pasta", "price": 289, "inventory": 100},
  {"id": "parmesan", "title": "Parmesan Wedge", "price": 599, "inventory": 100},
  {"id": "bacon", "title": "Smoked Bacon", "price": 699, "inventory": 100},
  {"id": "avocado", "title": "Avocado", "price": 199, "inventory": 100},
  {"id": "tomato", "title": "Roma Tomatoes", "price": 249, "inventory": 100},
  {"id": "onion", "title": "Yellow Onion", "price": 149, "inventory": 100},
  {"id": "lime", "title": "Fresh Lime", "price": 99, "inventory": 100},
  {"id": "jalapeno", "title": "Jalapeno Pepper", "price": 129, "inventory": 100},
  {"id": "cilantro", "title": "Cilantro Bunch", "price": 129, "inventory": 100},
  {"id": "tortillas", "title": "Corn Tortillas", "price": 299, "inventory": 100},
  {"id": "ground_beef", "title": "Ground Beef", "price": 899, "inventory": 100},
  {"id": "taco_seasoning", "title": "Taco Seasoning", "price": 199, "inventory": 100},
  {"id": "cheddar", "title": "Cheddar Cheese", "price": 549, "inventory": 100},
  {"id": "lettuce", "title": "Romaine Lettuce", "price": 249, "inventory": 100},
  {"id": "chicken_breast", "title": "Chicken Breast", "price": 1099, "inventory": 100},
  {"id": "rice", "title": "Jasmine Rice", "price": 299, "inventory": 100},
  {"id": "black_beans", "title": "Black Beans", "price": 179, "inventory": 100},
  {"id": "garlic", "title": "Garlic", "price": 99, "inventory": 100},
  {"id": "olive_oil", "title": "Olive Oil", "price": 799, "inventory": 100},
  {"id": "butter", "title": "Unsalted Butter", "price": 399, "inventory": 100},
  {"id": "bread", "title": "Sourdough Bread", "price": 499, "inventory": 100},
  {"id": "cucumber", "title": "Cucumber", "price": 149, "inventory": 100},
  {"id": "greek_yogurt", "title": "Greek Yogurt", "price": 549, "inventory": 100},
  {"id": "lemon", "title": "Lemon", "price": 99, "inventory": 100},
  {"id": "basil", "title": "Fresh Basil", "price": 199, "inventory": 100},
  {"id": "salmon", "title": "Atlantic Salmon", "price": 1299, "inventory": 100},
  {"id": "soy_sauce", "title": "Soy Sauce", "price": 299, "inventory": 100},
  {"id": "ginger", "title": "Ginger", "price": 129, "inventory": 100},
  {"id": "bell_pepper", "title": "Bell Pepper", "price": 179, "inventory": 100},
  {"id": "mushrooms", "title": "Cremini Mushrooms", "price": 349, "inventory": 100},
  {"id": "spinach", "title": "Baby Spinach", "price": 299, "inventory": 100},
  {"id": "shrimp", "title": "Shrimp", "price": 1199, "inventory": 100},
  {"id": "flour", "title": "All Purpose Flour", "price": 259, "inventory": 100},
  {"id": "sugar", "title": "Cane Sugar", "price": 239, "inventory": 100},
  {"id": "oats", "title": "Rolled Oats", "price": 329, "inventory": 100},
  {"id": "strawberries", "title": "Strawberries", "price": 399, "inventory": 100},
  {"id": "honey", "title": "Wildflower Honey", "price": 599, "inventory": 100},
  {"id": "chickpeas", "title": "Chickpeas", "price": 189, "inventory": 100},
  {"id": "quinoa", "title": "Quinoa", "price": 399, "inventory": 100},
  {"id": "feta", "title": "Feta Cheese", "price": 549, "inventory": 100},
  {"id": "salt", "title": "Sea Salt", "price": 149, "inventory": 100},
]


def main(argv) -> None:
  """Create and populate the grocery products database."""
  del argv
  db_path = Path(FLAGS.products_db_path)
  db_path.parent.mkdir(parents=True, exist_ok=True)

  conn = sqlite3.connect(db_path)
  try:
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("DROP TABLE IF EXISTS products")
    conn.execute(
      """
      CREATE TABLE products (
        id TEXT PRIMARY KEY,
        title TEXT,
        price INTEGER,
        image_url TEXT,
        inventory_quantity INTEGER
      )
      """
    )

    rows = []
    for item in GROCERY_ITEMS:
      image_url = f"https://picsum.photos/seed/{item['id']}/400/300"
      rows.append(
        (
          item["id"],
          item["title"],
          item["price"],
          image_url,
          item["inventory"],
        )
      )

    conn.executemany(
      """
      INSERT INTO products (id, title, price, image_url, inventory_quantity)
      VALUES (?, ?, ?, ?, ?)
      """,
      rows,
    )
    conn.commit()
  finally:
    conn.close()

  print(f"Wrote {len(GROCERY_ITEMS)} grocery items to {db_path}")


if __name__ == "__main__":
  absl_app.run(main)
