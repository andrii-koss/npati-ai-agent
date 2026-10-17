const { chromium } = require("playwright");
const path = require("path");

const ARTIFACT_DIR = "C:/Users/hostk/.gemini/antigravity-ide/brain/2981632b-b16e-45be-a1bf-8bda73d516b5";
const env = JSON.parse(require("fs").readFileSync(path.join(__dirname, "stage6-env.json"), "utf8"));
const PREVIEW_URL = `http://127.0.0.1:13001${env.previewUrl}`;

async function runBrowserTests() {
  console.log("=== Launching Playwright Chromium ===");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on("console", msg => console.log("PAGE LOG:", msg.type(), msg.text()));
  page.on("pageerror", err => console.error("PAGE ERROR:", err.message));
  page.on("requestfailed", req => console.warn("PAGE REQUEST FAILED:", req.method(), req.url(), req.failure()?.errorText));

  console.log("Navigating to Live Preview:", PREVIEW_URL);
  await page.goto(PREVIEW_URL, { waitUntil: "networkidle" });

  // 1. Check title & products
  const title = await page.title();
  console.log("Page title:", title);
  if (title !== "NPATI TechStore") throw new Error(`Unexpected title: ${title}`);

  await page.waitForSelector("#prod-prod-1");
  console.log("✓ Products list loaded successfully");
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "preview-initial-load.png") });

  // 2. Signup
  console.log("Executing Signup flow...");
  await page.click("#btn-signup");
  await page.fill("#reg-name", "Olena Test");
  await page.fill("#auth-email", "olena@test.ai");
  await page.fill("#auth-password", "StrongPass2026!");
  await page.click("#btn-login"); // In signup mode this triggers handleLogin -> signup

  await page.waitForFunction(() => {
    const el = document.getElementById("auth-msg");
    return el && el.innerText.includes("Успішно зареєстровано");
  }, { timeout: 5000 });
  console.log("✓ Signup confirmed");
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "preview-signup-success.png") });

  // 3. Login
  console.log("Executing Login flow...");
  await page.fill("#auth-email", "olena@test.ai");
  await page.fill("#auth-password", "StrongPass2026!");
  await page.click("#btn-login");

  await page.waitForFunction(() => {
    const el = document.getElementById("user-display");
    return el && el.innerText.includes("olena@test.ai");
  }, { timeout: 5000 });
  console.log("✓ Login confirmed, user display updated");
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "preview-logged-in.png") });

  // 4. Page Reload / Session check
  console.log("Testing page reload / refresh...");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#site-header");
  console.log("✓ Reload completed");

  // 5. Add products to cart
  console.log("Adding items to cart...");
  await page.click("#btn-add-prod-1");
  await page.click("#btn-add-prod-2");

  const cartCount = await page.innerText("#cart-count");
  const cartTotal = await page.innerText("#cart-total");
  console.log(`Cart Count: ${cartCount}, Total: $${cartTotal}`);
  if (cartCount !== "2") throw new Error(`Expected cart count 2, got ${cartCount}`);
  if (cartTotal !== "139.98") throw new Error(`Expected cart total 139.98, got ${cartTotal}`);
  console.log("✓ Add to Cart verified");
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "preview-cart-items.png") });

  // 6. Checkout / Order creation
  console.log("Executing Checkout / Order creation...");
  await page.click("#btn-checkout");

  await page.waitForFunction(() => {
    const el = document.getElementById("order-msg");
    return el && el.innerText.includes("успішно оформлено");
  }, { timeout: 5000 });

  const orderMsg = await page.innerText("#order-msg");
  console.log("✓ Order creation confirmed:", orderMsg);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "preview-order-success.png") });

  const cartCountAfter = await page.innerText("#cart-count");
  if (cartCountAfter !== "0") throw new Error(`Expected empty cart, got ${cartCountAfter}`);

  // 7. Logout
  console.log("Executing Logout flow...");
  // Re-login in case reload reset memory user
  await page.fill("#auth-email", "olena@test.ai");
  await page.fill("#auth-password", "StrongPass2026!");
  await page.click("#btn-login");
  await page.waitForSelector("#btn-logout", { state: "visible" });
  await page.click("#btn-logout");

  const userDisplay = await page.innerText("#user-display");
  console.log("User display after logout:", userDisplay);
  if (userDisplay !== "Not logged in") throw new Error(`Expected 'Not logged in', got '${userDisplay}'`);
  console.log("✓ Logout verified");
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "preview-logged-out.png") });

  await browser.close();
  console.log("=== All Playwright Browser Tests Passed Successfully! ===");
}

runBrowserTests().catch(err => {
  console.error("PLAYWRIGHT TEST FAILED:", err);
  process.exit(1);
});
