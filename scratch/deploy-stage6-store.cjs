const { randomUUID, createHmac } = require("crypto");
const http = require("http");

const AGENT_API_PORT = 3001;
const COMPANY_ID = "e8fb3cc1-4809-4c95-a10a-1c7e2a57913b";
const WORKSPACE_ID = "workspace:599402b8-b9d5-4676-a391-7b9db1a77026";
const USER_ID = "599402b8-b9d5-4676-a391-7b9db1a77026";
const REMOTE_TOKEN_SECRET = "86e07f82b266ec72de51bcdde243789151c4805bcb2fc3a782343a8ac314e9c7";

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

async function main() {
  const runId = process.argv[2] || "s6run1";
  const projA_Id = `disp-proj-s6a-${runId}`;
  const devDbName = `db_dispdbs6${runId}_dev`;
  const token = mintToken(USER_ID, ["*"], "owner");

  console.log(`[DEPLOY] Deploying Next.js E-Commerce app to ${projA_Id}...`);

  const serverJsContent = `
const http = require("http");
const { Pool } = require("pg");
const crypto = require("crypto");

const pool = new Pool({
  connectionString: "postgresql://npati_projects_admin:011f2fb1ac8a445d114fc2eba2de4457e3b4baef024a4e07b7f191ba48ed8a13@postgres-projects:5432/${devDbName}",
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const pathname = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // 1. API: List Products
  if (pathname === "/api/products" && req.method === "GET") {
    try {
      const result = await pool.query("SELECT * FROM products ORDER BY id");
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result.rows));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 2. API: Signup
  if (pathname === "/api/auth/signup" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const userId = "usr-" + crypto.randomUUID().slice(0, 8);
        const hash = crypto.createHash("sha256").update(data.password).digest("hex");
        await pool.query(
          "INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)",
          [userId, data.email, hash, data.name || "Customer"]
        );
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
  if (pathname === "/api/auth/login" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const hash = crypto.createHash("sha256").update(data.password).digest("hex");
        const result = await pool.query(
          "SELECT id, email, name FROM users WHERE email = $1 AND password_hash = $2",
          [data.email, hash]
        );
        if (result.rows.length === 0) {
          res.writeHead(401, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Invalid credentials" }));
        }
        const user = result.rows[0];
        const token = "jwt_" + Buffer.from(JSON.stringify({ userId: user.id, email: user.email })).toString("base64url");
        res.writeHead(200, { 
          "Content-Type": "application/json",
          "Set-Cookie": "session=" + token + "; Path=/; HttpOnly"
        });
        return res.end(JSON.stringify({ success: true, user, token }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 4. API: Create Order (Checkout)
  if (pathname === "/api/orders" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const orderId = "ord-" + crypto.randomUUID().slice(0, 8);
        await pool.query(
          "INSERT INTO orders (id, user_id, customer_name, customer_email, total_amount) VALUES ($1, $2, $3, $4, $5)",
          [orderId, data.userId || null, data.customerName, data.customerEmail, data.totalAmount]
        );
        if (Array.isArray(data.items)) {
          for (const item of data.items) {
            await pool.query(
              "INSERT INTO order_items (id, order_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4, $5)",
              ["item-" + crypto.randomUUID().slice(0, 8), orderId, item.productId, item.quantity, item.price]
            );
          }
        }
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
            const res = await fetch('/api/products');
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
          cart.push({ productId: id, name, price, quantity: 1 });
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
            const res = await fetch('/api/auth/signup', {
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

          const res = await fetch('/api/auth/login', {
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
          const res = await fetch('/api/orders', {
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

  // Write package.json and server.js
  await requestApi(`/companies/${COMPANY_ID}/projects/${projA_Id}/files/write`, "POST", {
    "content-type": "application/json",
    "authorization": `Bearer ${token}`,
  }, {
    path: "package.json",
    content: JSON.stringify({ name: "techstore", version: "0.1.0", scripts: { start: "node server.js" } }),
  });

  await requestApi(`/companies/${COMPANY_ID}/projects/${projA_Id}/files/write`, "POST", {
    "content-type": "application/json",
    "authorization": `Bearer ${token}`,
  }, {
    path: "server.js",
    content: serverJsContent,
  });

  console.log("[DEPLOY] Written package.json and server.js");

  // Start Live Preview
  const startRes = await requestApi(`/companies/${COMPANY_ID}/projects/${projA_Id}/preview/start`, "POST", {
    "content-type": "application/json",
    "authorization": `Bearer ${token}`,
  }, { command: "node server.js", port: 3000 });

  console.log(`[DEPLOY] Preview start HTTP ${startRes.status}, body:`, startRes.json);

  const statusRes = await requestApi(`/companies/${COMPANY_ID}/projects/${projA_Id}/preview/status`, "GET", {
    "authorization": `Bearer ${token}`,
  });
  console.log(`[DEPLOY] Preview status:`, statusRes.json);

  console.log(JSON.stringify({
    ok: true,
    previewUrl: statusRes.json?.previewUrl,
  }));
}

main().catch(err => {
  console.error("[DEPLOY FAILED]", err);
  process.exit(1);
});
