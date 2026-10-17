const { Pool } = require("pg");
const { randomUUID, createHmac } = require("crypto");
const http = require("http");
const { Client } = require("minio");

const COMPANY_ID = "e8fb3cc1-4809-4c95-a10a-1c7e2a57913b";
const WORKSPACE_ID = "workspace:599402b8-b9d5-4676-a391-7b9db1a77026";
const USER_ID = "599402b8-b9d5-4676-a391-7b9db1a77026";
const REAL_PROJECT_ID = "715009ee-a7bf-4999-bce2-053d207b7af5";
const REMOTE_TOKEN_SECRET = "86e07f82b266ec72de51bcdde243789151c4805bcb2fc3a782343a8ac314e9c7";
const AGENT_API_PORT = 3001;

const corePool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://npati:b1f58d50ff5b81c16b62ba8a306d179bc5bdb1a959b38b0c0442946c2469f090@postgres:5432/npati_agent",
});

const projectsAdminPool = new Pool({
  connectionString: "postgresql://npati_projects_admin:011f2fb1ac8a445d114fc2eba2de4457e3b4baef024a4e07b7f191ba48ed8a13@postgres-projects:5432/postgres",
});

const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT || "npati-isolated-source-20261011-minio-internal",
  port: parseInt(process.env.MINIO_PORT || "9000", 10),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || "validation-admin",
  secretKey: process.env.MINIO_SECRET_KEY || "ce8f0d6502c25e141bb8c9f728b06e4c28de5bccbf67dd7d3f3f8dfdb67605e8",
});
const BUCKET = "npati-project-media";

function mintToken(userId, scopes = ["*"], role = "owner") {
  const tokenId = `rat_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = new Date();
  const details = {
    tokenId,
    tenantId: WORKSPACE_ID,
    companyId: COMPANY_ID,
    userId,
    scopes,
    role,
    expiresAt: new Date(now.getTime() + 3600 * 1000).toISOString(),
    createdAt: now.toISOString(),
  };
  const payloadBase64 = Buffer.from(JSON.stringify(details)).toString("base64url");
  const signature = createHmac("sha256", REMOTE_TOKEN_SECRET).update(payloadBase64).digest("base64url");
  return `${tokenId}.${payloadBase64}.${signature}`;
}

function requestApi(path, method = "GET", headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: AGENT_API_PORT,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      }
    );
    req.on("error", reject);
    if (body) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function start() {
  const projA_Id = randomUUID();
  const projB_Id = randomUUID();
  const dispBackendId = randomUUID();
  const devDbName = `db_${dispBackendId.replace(/-/g, "")}_dev`;
  const prodDbName = `db_${dispBackendId.replace(/-/g, "")}_prod`;
  const ownerToken = mintToken(USER_ID, ["*"], "owner");

  console.log("================================================================================");
  console.log(`[STAGE 6 RUNNER] Initializing test contour`);
  console.log(`Project A: ${projA_Id}`);
  console.log(`Project B: ${projB_Id}`);
  console.log(`Backend ID: ${dispBackendId}`);
  console.log(`Dev DB: ${devDbName}`);
  console.log("================================================================================\n");

  // 1. Create dedicated Postgres databases in postgres-projects
  await projectsAdminPool.query(`CREATE DATABASE "${devDbName}"`);
  await projectsAdminPool.query(`CREATE DATABASE "${prodDbName}"`);
  console.log(`✓ Created isolated databases: ${devDbName}, ${prodDbName}`);

  // 2. Provision store schema in dev database
  const devPool = new Pool({
    connectionString: `postgresql://npati_projects_admin:011f2fb1ac8a445d114fc2eba2de4457e3b4baef024a4e07b7f191ba48ed8a13@postgres-projects:5432/${devDbName}`,
  });

  await devPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS products (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      price NUMERIC(10, 2) NOT NULL,
      image_url VARCHAR(500),
      stock INTEGER DEFAULT 10,
      badge VARCHAR(50),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) REFERENCES users(id),
      customer_name VARCHAR(255) NOT NULL,
      customer_email VARCHAR(255) NOT NULL,
      total_amount NUMERIC(10, 2) NOT NULL,
      status VARCHAR(50) DEFAULT 'confirmed',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id VARCHAR(64) PRIMARY KEY,
      order_id VARCHAR(64) REFERENCES orders(id),
      product_id VARCHAR(64) REFERENCES products(id),
      quantity INTEGER NOT NULL,
      unit_price NUMERIC(10, 2) NOT NULL
    );
  `);

  await devPool.query(`
    INSERT INTO products (id, name, description, price, image_url, stock) VALUES
      ('prod-1', 'Mechanical Pro Keyboard', 'RGB Mechanical Gaming Keyboard with tactile switches', 89.99, '/api/projects/${projA_Id}/media/assets/keyboard.svg', 15),
      ('prod-2', 'Wireless Precision Mouse', 'Ultra-lightweight ergonomic wireless mouse', 49.99, '/api/projects/${projA_Id}/media/assets/mouse.svg', 25),
      ('prod-3', 'Studio Gaming Headset', 'Noise-canceling spatial audio surround headset', 119.99, '/api/projects/${projA_Id}/media/assets/headset.svg', 10);
  `);
  console.log(`✓ Seeded products table with 3 initial items`);
  await devPool.end();

  // 3. Register DataBackend in NPATI Core PostgreSQL
  const now = new Date().toISOString();
  await corePool.query(
    `INSERT INTO data_backends (id, workspace_id, company_id, created_by, name, provider, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Disposable Backend Stage 6', 'shared_postgres', 'ready', $5, $5)`,
    [dispBackendId, WORKSPACE_ID, COMPANY_ID, USER_ID, now]
  );
  for (const env of ["dev", "prod"]) {
    await corePool.query(
      `INSERT INTO data_backend_environments (id, workspace_id, company_id, backend_id, environment, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [randomUUID(), WORKSPACE_ID, COMPANY_ID, dispBackendId, env, now]
    );
  }

  // 4. Create Project A and Project B
  const toolchainJson = JSON.stringify({ framework: "nextjs" });
  await corePool.query(
    `INSERT INTO projects (id, workspace_id, company_id, name, type, toolchain, status, data_backend_id, revision, created_by, create_request_key, data_classification, retention_class, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'website', $5, 'ready', $6, 1, $7, $8, 'confidential', 'standard', $9, $9)`,
    [projA_Id, WORKSPACE_ID, COMPANY_ID, `E2E TechStore`, toolchainJson, dispBackendId, USER_ID, `req-key-${projA_Id}`, now]
  );
  await corePool.query(
    `INSERT INTO projects (id, workspace_id, company_id, name, type, toolchain, status, data_backend_id, revision, created_by, create_request_key, data_classification, retention_class, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'website', $5, 'ready', $6, 1, $7, $8, 'confidential', 'standard', $9, $9)`,
    [projB_Id, WORKSPACE_ID, COMPANY_ID, `Isolated Site B`, toolchainJson, dispBackendId, USER_ID, `req-key-${projB_Id}`, now]
  );
  console.log(`✓ Created Project A and Project B in projects table`);

  // 5. Upload media to MinIO
  const keyboardSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#1e293b" rx="10"/><text x="50" y="55" fill="#38bdf8" font-family="sans-serif" font-size="12" text-anchor="middle">Keyboard</text></svg>`;
  const mouseSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#1e293b" rx="10"/><text x="50" y="55" fill="#4ade80" font-family="sans-serif" font-size="12" text-anchor="middle">Mouse</text></svg>`;
  const headsetSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#1e293b" rx="10"/><text x="50" y="55" fill="#fb923c" font-family="sans-serif" font-size="12" text-anchor="middle">Headset</text></svg>`;

  await minioClient.putObject(BUCKET, `${COMPANY_ID}/${projA_Id}/assets/keyboard.svg`, Buffer.from(keyboardSvg), keyboardSvg.length, { "content-type": "image/svg+xml" });
  await minioClient.putObject(BUCKET, `${COMPANY_ID}/${projA_Id}/assets/mouse.svg`, Buffer.from(mouseSvg), mouseSvg.length, { "content-type": "image/svg+xml" });
  await minioClient.putObject(BUCKET, `${COMPANY_ID}/${projA_Id}/assets/headset.svg`, Buffer.from(headsetSvg), headsetSvg.length, { "content-type": "image/svg+xml" });
  console.log(`✓ MinIO product media uploaded under prefix ${COMPANY_ID}/${projA_Id}/assets/`);

  // 6. Write Application code to workspace
  const serverJs = `
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, "users.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return def; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

let products = [
  { id: "prod-1", name: "Mechanical Pro Keyboard", description: "RGB Mechanical Gaming Keyboard with tactile switches", price: 89.99, image_url: "/api/projects/${projA_Id}/media/assets/keyboard.svg", stock: 15 },
  { id: "prod-2", name: "Wireless Precision Mouse", description: "Ultra-lightweight ergonomic wireless mouse", price: 49.99, image_url: "/api/projects/${projA_Id}/media/assets/mouse.svg", stock: 25 },
  { id: "prod-3", name: "Studio Gaming Headset", description: "Noise-canceling spatial audio surround headset", price: 119.99, image_url: "/api/projects/${projA_Id}/media/assets/headset.svg", stock: 10 }
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:3000");
  const pathname = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // 1. API: List Products
  if (pathname === "/store/products" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(products));
  }

  // 2. API: Signup
  if (pathname === "/store/auth/signup" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const users = readJson(USERS_FILE, []);
        const userId = "usr-" + crypto.randomUUID().slice(0, 8);
        const hash = crypto.createHash("sha256").update(data.password).digest("hex");
        const newUser = { id: userId, email: data.email, password_hash: hash, name: data.name || "Customer" };
        users.push(newUser);
        writeJson(USERS_FILE, users);
        res.writeHead(201, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: true, userId, email: data.email }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 3. API: Login
  if (pathname === "/store/auth/login" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const users = readJson(USERS_FILE, []);
        const hash = crypto.createHash("sha256").update(data.password).digest("hex");
        const user = users.find(u => u.email === data.email && u.password_hash === hash);
        if (!user) {
          res.writeHead(401, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Invalid credentials" }));
        }
        const token = "jwt_" + Buffer.from(JSON.stringify({ userId: user.id, email: user.email })).toString("base64url");
        res.writeHead(200, { 
          "Content-Type": "application/json",
          "Set-Cookie": "session=" + token + "; Path=/; HttpOnly"
        });
        return res.end(JSON.stringify({ success: true, user: { id: user.id, email: user.email, name: user.name }, token }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 4. API: Create Order
  if (pathname === "/store/orders" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const orders = readJson(ORDERS_FILE, []);
        const orderId = "ord-" + crypto.randomUUID().slice(0, 8);
        const newOrder = {
          id: orderId,
          userId: data.userId || null,
          customerName: data.customerName,
          customerEmail: data.customerEmail,
          totalAmount: data.totalAmount,
          items: data.items,
          status: "confirmed",
          createdAt: new Date().toISOString()
        };
        orders.push(newOrder);
        writeJson(ORDERS_FILE, orders);
        res.writeHead(201, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: true, orderId }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 5. Frontend HTML UI
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(\`
    <!DOCTYPE html>
    <html lang="uk">
    <head>
      <meta charset="utf-8">
      <title>NPATI TechStore</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 20px; background: #0f172a; color: #f8fafc; }
        header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 15px; margin-bottom: 20px; }
        h1 { margin: 0; color: #38bdf8; }
        .card { background: #1e293b; border-radius: 8px; padding: 15px; margin-bottom: 15px; border: 1px solid #334155; }
        .products-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 15px; }
        .product-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 15px; text-align: center; }
        button { background: #0284c7; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; }
        button:hover { background: #0369a1; }
        input { background: #0f172a; border: 1px solid #334155; color: white; padding: 8px; border-radius: 6px; margin: 5px 0; width: 100%; box-sizing: border-box; }
        .cart-badge { background: #ef4444; color: white; border-radius: 999px; padding: 2px 8px; font-size: 12px; }
        .badge-new { background: #10b981; color: white; border-radius: 4px; padding: 2px 6px; font-size: 11px; margin-left: 5px; }
        .auth-status { color: #10b981; font-weight: bold; }
      </style>
    </head>
    <body>
      <header id="site-header">
        <h1>NPATI TechStore</h1>
        <div>
          <span id="user-display">Not logged in</span>
          <span style="margin-left: 15px;">Кошик: <span id="cart-count" class="cart-badge">0</span></span>
        </div>
      </header>

      <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 20px;">
        <div>
          <h2>Товари</h2>
          <div id="products-list" class="products-grid">Завантаження...</div>
        </div>

        <div>
          <div class="card" id="auth-box">
            <h3 id="auth-title">Вхід покупця</h3>
            <div id="signup-fields" style="display:none;">
              <input type="text" id="reg-name" placeholder="Ім'я">
            </div>
            <input type="email" id="auth-email" placeholder="Email" value="buyer@npati.ai">
            <input type="password" id="auth-password" placeholder="Пароль" value="Secret123!">
            <div style="margin-top: 10px; display: flex; gap: 10px;">
              <button id="btn-login" onclick="handleLogin()">Увійти</button>
              <button id="btn-signup" onclick="toggleSignup()" style="background:#475569;">Реєстрація</button>
              <button id="btn-logout" onclick="handleLogout()" style="display:none; background:#dc2626;">Вийти</button>
            </div>
            <p id="auth-msg"></p>
          </div>

          <div class="card">
            <h3>Кошик та замовлення</h3>
            <div id="cart-items">Кошик порожній</div>
            <div style="margin-top: 10px; font-weight: bold;">Разом: $<span id="cart-total">0.00</span></div>
            <button id="btn-checkout" onclick="handleCheckout()" style="margin-top: 15px; width: 100%; background: #16a34a;">Оформити замовлення</button>
            <p id="order-msg"></p>
          </div>
        </div>
      </div>

      <script>
        let currentUser = null;
        let cart = [];
        let isSignupMode = false;

        async function loadProducts() {
          try {
            const res = await fetch('/store/products');
            const products = await res.json();
            const list = document.getElementById('products-list');
            list.innerHTML = products.map(p => \\\`
              <div class="product-card" id="prod-\\\${p.id}">
                <img src="\\\${p.image_url}" style="height: 60px; margin-bottom: 10px;" alt="\\\${p.name}">
                <h4>\\\${p.name} \\\${p.badge ? '<span class="badge-new">\\\${p.badge}</span>' : ''}</h4>
                <p style="color: #94a3b8; font-size: 13px;">\\\${p.description}</p>
                <div style="font-size: 18px; font-weight: bold; margin: 10px 0;">$\\\${p.price}</div>
                <button id="btn-add-\\\${p.id}" onclick="addToCart('\\\${p.id}', '\\\${p.name}', \\\${p.price})">Додати в кошик</button>
              </div>
            \\\`).join('');
          } catch (err) {
            document.getElementById('products-list').innerText = 'Помилка: ' + err.message;
          }
        }

        function addToCart(id, name, price) {
          cart.push({ productId: id, name, price: Number(price), quantity: 1 });
          updateCart();
        }

        function updateCart() {
          document.getElementById('cart-count').innerText = cart.length;
          const total = cart.reduce((sum, i) => sum + i.price, 0);
          document.getElementById('cart-total').innerText = total.toFixed(2);
          const itemsDiv = document.getElementById('cart-items');
          if (cart.length === 0) {
            itemsDiv.innerText = 'Кошик порожній';
          } else {
            itemsDiv.innerHTML = cart.map(i => '<div>' + i.name + ' - $' + i.price + '</div>').join('');
          }
        }

        function toggleSignup() {
          isSignupMode = !isSignupMode;
          document.getElementById('signup-fields').style.display = isSignupMode ? 'block' : 'none';
          document.getElementById('auth-title').innerText = isSignupMode ? 'Нова реєстрація' : 'Вхід покупця';
          document.getElementById('btn-login').innerText = isSignupMode ? 'Зареєструватися' : 'Увійти';
        }

        async function handleLogin() {
          const email = document.getElementById('auth-email').value;
          const password = document.getElementById('auth-password').value;
          const authMsg = document.getElementById('auth-msg');

          if (isSignupMode) {
            const name = document.getElementById('reg-name').value || 'Customer';
            const res = await fetch('/store/auth/signup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, password, name })
            });
            const data = await res.json();
            if (data.success) {
              toggleSignup();
              authMsg.innerText = 'Успішно зареєстровано! Увійдіть.';
            } else {
              authMsg.innerText = 'Помилка: ' + data.error;
            }
            return;
          }

          const res = await fetch('/store/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
          });
          const data = await res.json();
          if (data.success) {
            currentUser = data.user;
            localStorage.setItem('auth_token', data.token);
            document.getElementById('user-display').innerText = 'Користувач: ' + currentUser.email;
            document.getElementById('btn-login').style.display = 'none';
            document.getElementById('btn-signup').style.display = 'none';
            document.getElementById('btn-logout').style.display = 'inline-block';
            authMsg.innerText = 'Вхід виконано!';
            authMsg.className = 'auth-status';
          } else {
            authMsg.innerText = 'Помилка: ' + data.error;
          }
        }

        function handleLogout() {
          currentUser = null;
          localStorage.removeItem('auth_token');
          document.getElementById('user-display').innerText = 'Not logged in';
          document.getElementById('btn-login').style.display = 'inline-block';
          document.getElementById('btn-signup').style.display = 'inline-block';
          document.getElementById('btn-logout').style.display = 'none';
          document.getElementById('auth-msg').innerText = 'Ви вийшли із системи.';
        }

        async function handleCheckout() {
          const orderMsg = document.getElementById('order-msg');
          if (cart.length === 0) {
            orderMsg.innerText = 'Кошик порожній!';
            return;
          }
          const total = cart.reduce((sum, i) => sum + i.price, 0);
          const res = await fetch('/store/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: currentUser ? currentUser.id : null,
              customerName: currentUser ? currentUser.name : 'Guest',
              customerEmail: currentUser ? currentUser.email : 'guest@npati.ai',
              totalAmount: total,
              items: cart
            })
          });
          const data = await res.json();
          if (data.success) {
            orderMsg.innerText = 'Замовлення ' + data.orderId + ' успішно оформлено!';
            orderMsg.style.color = '#10b981';
            cart = [];
            updateCart();
          } else {
            orderMsg.innerText = 'Помилка: ' + data.error;
          }
        }

        loadProducts();
      </script>
    </body>
    </html>
  \`);
});

const port = process.env.PORT || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log("TechStore Server listening on " + port);
});
`;

  await requestApi(`/companies/${COMPANY_ID}/projects/${projA_Id}/files/write`, "POST", {
    "content-type": "application/json",
    "authorization": `Bearer ${ownerToken}`,
  }, { path: "package.json", content: JSON.stringify({ name: "techstore", version: "0.1.0", scripts: { start: "node server.js" } }) });

  await requestApi(`/companies/${COMPANY_ID}/projects/${projA_Id}/files/write`, "POST", {
    "content-type": "application/json",
    "authorization": `Bearer ${ownerToken}`,
  }, { path: "server.js", content: serverJs });

  console.log(`✓ Written package.json and server.js to workspace of ${projA_Id}`);

  // 7. Start Live Preview
  const startRes = await requestApi(`/companies/${COMPANY_ID}/projects/${projA_Id}/preview/start`, "POST", {
    "content-type": "application/json",
    "authorization": `Bearer ${ownerToken}`,
  }, { command: "node server.js", port: 3000 });
  console.log(`✓ Live Preview start response: HTTP ${startRes.status}`);

  const statusRes = await requestApi(`/companies/${COMPANY_ID}/projects/${projA_Id}/preview/status`, "GET", {
    "authorization": `Bearer ${ownerToken}`,
  });
  console.log(`✓ Live Preview status: ${statusRes.json?.status}, url: ${statusRes.json?.previewUrl}`);

  await corePool.end();
  await projectsAdminPool.end();

  const metrics = {
    projA: projA_Id,
    projB: projB_Id,
    backendId: dispBackendId,
    devDbName,
    prodDbName,
    previewUrl: statusRes.json?.previewUrl,
  };
  require("fs").writeFileSync("/tmp/stage6-env.json", JSON.stringify(metrics, null, 2));
  console.log("__STAGE6_METRICS__" + JSON.stringify(metrics));
}

start().catch(err => {
  console.error("STAGE 6 START FAILED:", err);
  process.exit(1);
});
