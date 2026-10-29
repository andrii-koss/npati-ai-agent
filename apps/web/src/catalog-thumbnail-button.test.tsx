// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { CatalogProjectThumbnail } from "./catalog-project-thumbnail";
vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => "button-state", getStoredAuthUser: () => ({ id: "button-state" }) }));

describe("screenshot button feedback", () => {
  it.each([true, false])("shows progress and restores its original appearance after success=%s", async success => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/qa/thumbnail') && init?.method === 'POST') return new Promise<Response>(resolve => { finish = resolve; });
      return new Response(JSON.stringify(url.endsWith('/status') ? { isRunning: true } : url.endsWith('/token') ? { token: 'token' } : { thumbnail: null }));
    }));
    const host=document.createElement('div'),root=createRoot(host);
    try {
      await act(async()=>root.render(<CatalogProjectThumbnail companyId="c" projectId={success?'success':'failure'} name="Site" language="en" onPreview={()=>{}} />));
      const button=host.querySelector<HTMLButtonElement>('.website-thumbnail-refresh')!,icon=button.querySelector('svg')!;
      expect(button.classList.contains('button-secondary')).toBe(true);expect(icon.getAttribute('width')).toBe('14');
      expect(button.textContent).toBe('');expect(button.title).toBe('Refresh screenshot');
      await act(async()=>button.click());
      expect(button.disabled).toBe(true);expect(button.getAttribute('aria-busy')).toBe('true');expect(icon.style.animation).toContain('website-preview-spin');
      await act(async()=>finish(new Response(JSON.stringify(success?{thumbnail:{dataUrl:'data:image/png;base64,fixture',capturedAt:'2026-10-29'}}:{error:{message:'Capture failed'}}),{status:success?200:503})));
      expect(button.disabled).toBe(false);expect(button.getAttribute('aria-busy')).toBe('false');expect(icon.style.animation).toBe('');expect(button.textContent).toBe('');
    } finally { await act(async()=>root.unmount());vi.unstubAllGlobals(); }
  });
});
