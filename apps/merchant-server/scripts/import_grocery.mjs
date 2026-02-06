import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DEFAULT_PRODUCTS_DB = "/tmp/ucp_test/products.db";

const parseArgs = (argv) => {
  let productsDbPath = process.env.PRODUCTS_DB_PATH || DEFAULT_PRODUCTS_DB;
  argv.forEach((arg, index) => {
    if (arg.startsWith("--products_db_path=")) {
      productsDbPath = arg.split("=")[1];
    } else if (arg === "--products_db_path" && argv[index + 1]) {
      productsDbPath = argv[index + 1];
    } else if (arg.startsWith("--products-db-path=")) {
      productsDbPath = arg.split("=")[1];
    }
  });
  return productsDbPath;
};

const productsDbPath = parseArgs(process.argv.slice(2));
fs.mkdirSync(path.dirname(productsDbPath), { recursive: true });

const GROCERY_ITEMS = [
  { id: "milk", title: "Whole Milk", price: 399, inventory: 100 },
  { id: "eggs", title: "Free Range Eggs", price: 449, inventory: 100 },
  { id: "pasta", title: "Spaghetti Pasta", price: 289, inventory: 100 },
  { id: "parmesan", title: "Parmesan Wedge", price: 599, inventory: 100 },
  { id: "bacon", title: "Smoked Bacon", price: 699, inventory: 100 },
  { id: "avocado", title: "Avocado", price: 199, inventory: 100 },
  { id: "tomato", title: "Roma Tomatoes", price: 249, inventory: 100 },
  { id: "onion", title: "Yellow Onion", price: 149, inventory: 100 },
  { id: "lime", title: "Fresh Lime", price: 99, inventory: 100 },
  { id: "jalapeno", title: "Jalapeno Pepper", price: 129, inventory: 100 },
  { id: "cilantro", title: "Cilantro Bunch", price: 129, inventory: 100 },
  { id: "tortillas", title: "Corn Tortillas", price: 299, inventory: 100 },
  { id: "ground_beef", title: "Ground Beef", price: 899, inventory: 100 },
  { id: "taco_seasoning", title: "Taco Seasoning", price: 199, inventory: 100 },
  { id: "cheddar", title: "Cheddar Cheese", price: 549, inventory: 100 },
  { id: "lettuce", title: "Romaine Lettuce", price: 249, inventory: 100 },
  { id: "chicken_breast", title: "Chicken Breast", price: 1099, inventory: 100 },
  { id: "rice", title: "Jasmine Rice", price: 299, inventory: 100 },
  { id: "black_beans", title: "Black Beans", price: 179, inventory: 100 },
  { id: "garlic", title: "Garlic", price: 99, inventory: 100 },
  { id: "olive_oil", title: "Olive Oil", price: 799, inventory: 100 },
  { id: "butter", title: "Unsalted Butter", price: 399, inventory: 100 },
  { id: "bread", title: "Sourdough Bread", price: 499, inventory: 100 },
  { id: "cucumber", title: "Cucumber", price: 149, inventory: 100 },
  { id: "greek_yogurt", title: "Greek Yogurt", price: 549, inventory: 100 },
  { id: "lemon", title: "Lemon", price: 99, inventory: 100 },
  { id: "basil", title: "Fresh Basil", price: 199, inventory: 100 },
  { id: "salmon", title: "Atlantic Salmon", price: 1299, inventory: 100 },
  { id: "soy_sauce", title: "Soy Sauce", price: 299, inventory: 100 },
  { id: "ginger", title: "Ginger", price: 129, inventory: 100 },
  { id: "bell_pepper", title: "Bell Pepper", price: 179, inventory: 100 },
  { id: "mushrooms", title: "Cremini Mushrooms", price: 349, inventory: 100 },
  { id: "spinach", title: "Baby Spinach", price: 299, inventory: 100 },
  { id: "shrimp", title: "Shrimp", price: 1199, inventory: 100 },
  { id: "flour", title: "All Purpose Flour", price: 259, inventory: 100 },
  { id: "sugar", title: "Cane Sugar", price: 239, inventory: 100 },
  { id: "oats", title: "Rolled Oats", price: 329, inventory: 100 },
  { id: "strawberries", title: "Strawberries", price: 399, inventory: 100 },
  { id: "honey", title: "Wildflower Honey", price: 599, inventory: 100 },
  { id: "chickpeas", title: "Chickpeas", price: 189, inventory: 100 },
  { id: "quinoa", title: "Quinoa", price: 399, inventory: 100 },
  { id: "feta", title: "Feta Cheese", price: 549, inventory: 100 },
  { id: "salt", title: "Sea Salt", price: 149, inventory: 100 },
];

const db = new Database(productsDbPath);
try {
  db.pragma("journal_mode = WAL");
  db.exec("DROP TABLE IF EXISTS products");
  db.exec(
    `
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      title TEXT,
      price INTEGER,
      image_url TEXT,
      inventory_quantity INTEGER
    )
    `
  );

  const insert = db.prepare(
    "INSERT INTO products (id, title, price, image_url, inventory_quantity) VALUES (?, ?, ?, ?, ?)"
  );
  const insertMany = db.transaction((items) => {
    items.forEach((item) => {
      const imageUrl = `https://picsum.photos/seed/${item.id}/400/300`;
      insert.run(item.id, item.title, item.price, imageUrl, item.inventory);
    });
  });

  insertMany(GROCERY_ITEMS);
  console.log(`Wrote ${GROCERY_ITEMS.length} grocery items to ${productsDbPath}`);
} finally {
  db.close();
}
