/**
 * Robust SVG Sanitizer to prevent Stored XSS, XXE, SSRF and nested HTML injection.
 * Strips script tags, event handlers, foreignObject, hazardous URI schemes, and XML entities.
 */

export interface SvgSanitizeResult {
  sanitized: Buffer;
  safe: boolean;
  violations: string[];
}

export function sanitizeSvg(input: Buffer | string): SvgSanitizeResult {
  let content = typeof input === "string" ? input : input.toString("utf8");
  const violations: string[] = [];

  // 1. Check & strip XXE / external DTD / DOCTYPE entities
  if (/<!ENTITY/i.test(content) || /SYSTEM\s+["']/i.test(content) || /PUBLIC\s+["']/i.test(content)) {
    violations.push("xxe_entity_detected");
    // Strip <!DOCTYPE ... [ ... ]> or <!ENTITY ...>
    content = content.replace(/<!DOCTYPE[^>\[]*(\[[^\]]*\])?>/gi, "");
    content = content.replace(/<!ENTITY[^>]*>/gi, "");
  }

  // 2. Strip XML stylesheets referencing external or dangerous resources
  if (/<\?xml-stylesheet/i.test(content)) {
    violations.push("xml_stylesheet_detected");
    content = content.replace(/<\?xml-stylesheet[^?]*\?>/gi, "");
  }

  // 3. Strip <script> tags and contents
  if (/<script\b/i.test(content)) {
    violations.push("script_tag_detected");
    content = content.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
    content = content.replace(/<script\b[^>]*\/>/gi, "");
    content = content.replace(/<script\b[^>]*>/gi, "");
  }

  // 4. Strip <foreignObject> tags and contents (often used to inject HTML/XSS inside SVG)
  if (/<foreignObject\b/i.test(content)) {
    violations.push("foreign_object_detected");
    content = content.replace(/<foreignObject\b[^<]*(?:(?!<\/foreignObject>)<[^<]*)*<\/foreignObject>/gi, "");
    content = content.replace(/<foreignObject\b[^>]*\/>/gi, "");
    content = content.replace(/<foreignObject\b[^>]*>/gi, "");
  }

  // 5. Strip dangerous elements: object, embed, iframe, applet, meta, link, base
  const dangerousTags = ["object", "embed", "iframe", "applet", "meta", "link", "base", "form", "input", "button"];
  for (const tag of dangerousTags) {
    const regexFull = new RegExp(`<${tag}\\b[^<]*(?:(?!<\\/${tag}>)<[^<]*)*<\\/${tag}>`, "gi");
    const regexSelf = new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi");
    if (regexFull.test(content) || regexSelf.test(content)) {
      violations.push(`dangerous_tag_${tag}`);
      content = content.replace(regexFull, "");
      content = content.replace(regexSelf, "");
    }
  }

  // 6. Strip inline event handlers: onload, onerror, onclick, onmouseover, etc.
  const eventHandlerRegex = /\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
  if (eventHandlerRegex.test(content)) {
    violations.push("inline_event_handler_detected");
    content = content.replace(eventHandlerRegex, "");
  }

  // 7. Strip href and xlink:href with javascript:, data:text/html, vbscript:
  const dangerousUriRegex = /\s+(?:xlink:)?href\s*=\s*(?:"\s*(?:javascript|data\s*:\s*text\/html|vbscript):[^"]*"|'\s*(?:javascript|data\s*:\s*text\/html|vbscript):[^']*')/gi;
  if (dangerousUriRegex.test(content)) {
    violations.push("dangerous_href_uri_detected");
    content = content.replace(dangerousUriRegex, "");
  }

  // Also check for encoded or whitespace-obfuscated javascript: in href
  const obfuscatedJsRegex = /\s+(?:xlink:)?href\s*=\s*(?:"[^"]*j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:[^"]*"|'[^']*j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:[^']*')/gi;
  if (obfuscatedJsRegex.test(content)) {
    violations.push("obfuscated_javascript_detected");
    content = content.replace(obfuscatedJsRegex, "");
  }

  const sanitizedBuffer = Buffer.from(content, "utf8");
  return {
    sanitized: sanitizedBuffer,
    safe: violations.length === 0,
    violations,
  };
}
