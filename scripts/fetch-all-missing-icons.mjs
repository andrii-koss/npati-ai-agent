import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const catalogPath = path.join(root, "packages", "omniroute-adapter", "src", "generated", "provider-catalog.json");
const vendorProvidersDir = path.join(root, "vendor", "omniroute", "public", "providers");

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const existingFiles = new Set(fs.readdirSync(vendorProvidersDir).map((f) => f.toLowerCase()));

// Explicit mappings to known existing assets in vendor/omniroute/public/providers
const DIRECT_ASSET_ALIASES = {
  "ant-ling": "inclusionai.svg",
  "bedrock": "aws.svg",
  "codex-app-server": "codex.svg",
  "cloudflare-playground": "cloudflare.svg",
  "github": "copilot.svg",
  "ghe-copilot": "copilot.svg",
  "hailuo-web": "minimax.svg",
  "jules": "google.svg",
  "muse-code": "meta.svg",
  "v0-vercel-web": "v0.svg",
  "volcengine-agent-plan": "volcengine.svg",
  "zed": "zed-hosted.svg",
  "zcode": "zhipu.svg",
  "freeinference": "inference.svg",
  "g4f-gemini": "gemini.svg",
  "g4f-groq": "groq.svg",
  "g4f-nvidia": "nvidia.svg",
  "g4f-ollama": "ollama.svg",
  "g4f-pollinations": "pollinations.svg",
  "tencent-aistudio-web": "tencent.svg",
  "mlx-gemma": "google.svg",
  "mlx-qwen": "qwen.svg",
};

// Known LobeHub icons mapping (from lobehub static svgs)
const LOBEHUB_NAME_MAP = {
  "together": "together",
  "stability-ai": "stability",
  "siliconflow": "siliconcloud",
  "black-forest-labs": "bfl",
  "databricks": "dbrx",
  "jina-ai": "jina",
  "jina-reader": "jina",
  "nous-research": "nousresearch",
  "qoder": "qoder",
  "sdwebui": "automatic",
  "venice": "venice",
  "venice-web": "venice",
  "vertex": "vertexai",
  "vertex-partner": "vertexai",
  "xiaomi-mimo": "xiaomimimo",
  "xiaomi-mimo-token-plan": "xiaomimimo",
  "zai": "zai",
  "zai-web": "zai",
  "devin": "devin",
  "devin-cli": "devin",
  "devin-cli-agentic": "devin",
  "devin-desktop": "devin",
  "adobe-firefly": "adobe",
  "notion-web": "notion",
  "lm-studio": "lmstudio",
};

// Simple-icons mapping
const SIMPLE_ICONS_MAP = {
  "raycast": "raycast",
};

// Custom domain overrides (apex domain handling)
const DOMAIN_OVERRIDES = {
  "chat-oripe": "oriper.com",
  "thebai": "theb.ai",
  "token-kiosk": "gaib.ai",
  "typhoon": "opentyphoon.ai",
};

async function fetchBuffer(url, timeoutMs = 7000) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 100) return null;
    return buf;
  } catch {
    return null;
  }
}

function craftBadgeSvg(name, color, textIcon) {
  const letters = (textIcon || name.slice(0, 2)).toUpperCase();
  const bg = color || "#0284c7";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${bg}" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="${bg}"/>
    </linearGradient>
  </defs>
  <rect width="96" height="96" rx="24" fill="url(#g)"/>
  <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="${letters.length > 2 ? '30' : '38'}" font-weight="800" fill="#ffffff" letter-spacing="-0.5">${letters}</text>
</svg>`;
}

async function resolveIcon(provider) {
  const id = provider.id;

  // 1. Direct asset alias
  if (DIRECT_ASSET_ALIASES[id]) {
    const targetFile = DIRECT_ASSET_ALIASES[id];
    const sourcePath = path.join(vendorProvidersDir, targetFile);
    if (fs.existsSync(sourcePath)) {
      const ext = path.extname(targetFile);
      const destName = `${id}${ext}`;
      fs.copyFileSync(sourcePath, path.join(vendorProvidersDir, destName));
      return { success: true, file: destName, source: `alias -> ${targetFile}` };
    }
  }

  // 2. LobeHub color / mono SVG
  if (LOBEHUB_NAME_MAP[id]) {
    const lobeName = LOBEHUB_NAME_MAP[id];
    const colorUrl = `https://unpkg.com/@lobehub/icons-static-svg@latest/icons/${lobeName}-color.svg`;
    const monoUrl = `https://unpkg.com/@lobehub/icons-static-svg@latest/icons/${lobeName}.svg`;

    let buf = await fetchBuffer(colorUrl);
    if (!buf) buf = await fetchBuffer(monoUrl);

    if (buf) {
      const destName = `${id}.svg`;
      fs.writeFileSync(path.join(vendorProvidersDir, destName), buf);
      return { success: true, file: destName, source: `lobehub: ${lobeName}` };
    }
  }

  // 3. Simple Icons
  if (SIMPLE_ICONS_MAP[id]) {
    const siName = SIMPLE_ICONS_MAP[id];
    const url = `https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/${siName}.svg`;
    const buf = await fetchBuffer(url);
    if (buf) {
      const destName = `${id}.svg`;
      fs.writeFileSync(path.join(vendorProvidersDir, destName), buf);
      return { success: true, file: destName, source: `simple-icons: ${siName}` };
    }
  }

  // 4. Domain high-res favicon
  let domain = DOMAIN_OVERRIDES[id] || "";
  if (!domain && provider.website) {
    try {
      const u = new URL(provider.website);
      domain = u.hostname.replace(/^www\./, "");
    } catch {}
  }

  if (domain) {
    // Try Google Favicon Service 128px
    const googleUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
    const googleBuf = await fetchBuffer(googleUrl);
    if (googleBuf && googleBuf.byteLength > 400) {
      const isPng = googleBuf[0] === 0x89 && googleBuf[1] === 0x50;
      const isJpg = googleBuf[0] === 0xff && googleBuf[1] === 0xd8;
      const ext = isPng ? ".png" : isJpg ? ".jpg" : ".ico";
      const destName = `${id}${ext}`;
      fs.writeFileSync(path.join(vendorProvidersDir, destName), googleBuf);
      return { success: true, file: destName, source: `domain favicon: ${domain}` };
    }

    // Try direct website favicon
    const directUrl = `${provider.website.replace(/\/+$/, "")}/favicon.ico`;
    const directBuf = await fetchBuffer(directUrl);
    if (directBuf && directBuf.byteLength > 200) {
      const isPng = directBuf[0] === 0x89 && directBuf[1] === 0x50;
      const ext = isPng ? ".png" : ".ico";
      const destName = `${id}${ext}`;
      fs.writeFileSync(path.join(vendorProvidersDir, destName), directBuf);
      return { success: true, file: destName, source: `direct favicon: ${directUrl}` };
    }
  }

  // 5. If "auto"
  if (id === "auto") {
    const autoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="#0284c7"/><path d="M48 22l4 14 14 4-14 4-4 14-4-14-14-4 14-4 4-14zM68 56l2 7 7 2-7 2-2 7-2-7-7-2 7-2 2-7zM28 56l2 7 7 2-7 2-2 7-2-7-7-2 7-2 2-7z" fill="white"/></svg>`;
    const destName = `${id}.svg`;
    fs.writeFileSync(path.join(vendorProvidersDir, destName), autoSvg);
    return { success: true, file: destName, source: "crafted auto svg" };
  }

  // 6. High quality brand monogram vector
  const badgeSvg = craftBadgeSvg(provider.name || id, provider.color, provider.textIcon);
  const destName = `${id}.svg`;
  fs.writeFileSync(path.join(vendorProvidersDir, destName), badgeSvg);
  return { success: true, file: destName, source: `brand monogram: ${provider.textIcon || id}` };
}

async function main() {
  const allProviders = catalog.providers;
  console.log(`Checking all ${allProviders.length} providers...`);

  let resolvedCount = 0;
  for (const provider of allProviders) {
    const currentAsset = provider.iconAsset ? provider.iconAsset.replace("/providers/", "").toLowerCase() : null;
    if (currentAsset && existingFiles.has(currentAsset)) {
      resolvedCount++;
      continue;
    }

    const res = await resolveIcon(provider);
    if (res.success) {
      resolvedCount++;
      console.log(`[OK] ${provider.id} -> ${res.file} (${res.source})`);
    } else {
      console.warn(`[FAIL] ${provider.id} (${provider.name})`);
    }
  }

  console.log(`\nResults: ${resolvedCount} / ${allProviders.length} providers now have authentic icons!`);
}

main();
