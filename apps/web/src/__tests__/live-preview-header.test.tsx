// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LivePreviewHeader, type DeviceMode } from "../LivePreviewHeader";

let root: ReturnType<typeof createRoot> | undefined;

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe("LivePreviewHeader", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  async function renderHeader(props: Partial<React.ComponentProps<typeof LivePreviewHeader>> = {}) {
    const defaultProps = {
      projectName: "Stress S15I Vite",
      runtimeStatus: "running" as const,
      previewUrl: "http://127.0.0.1:3001/preview",
      isUk: false,
      codeWorkspaceUrl: "/settings/code/comp1/proj1",
      terminalUrl: "/settings/code/comp1/proj1?tab=terminal",
      deviceMode: "desktop" as DeviceMode,
      setDeviceMode: vi.fn(),
      isFullscreen: false,
      setIsFullscreen: vi.fn(),
      onRefresh: vi.fn(),
      onClose: vi.fn(),
    };

    await act(async () => {
      root?.render(
        <MemoryRouter>
          <LivePreviewHeader {...defaultProps} {...props} />
        </MemoryRouter>
      );
    });
  }

  it("renders project name, status dot, and external link on the left side", async () => {
    await renderHeader();

    const titleEl = host.querySelector(".preview-header-project-name");
    expect(titleEl?.textContent).toBe("Stress S15I Vite");

    const dot = host.querySelector(".preview-header-status-dot");
    expect(dot?.classList.contains("status-running")).toBe(true);

    const extBtn = host.querySelector('button[aria-label="Open in new tab"]');
    expect(extBtn).not.toBeNull();
  });

  it("handles open in new tab when clicking ExternalLink", async () => {
    const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    await renderHeader({ previewUrl: "http://localhost:3000/test" });

    const extBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Open in new tab"]')!;
    await act(async () => {
      extBtn.click();
    });

    expect(windowOpenSpy).toHaveBeenCalledWith("http://localhost:3000/test", "_blank", "noopener,noreferrer");
    windowOpenSpy.mockRestore();
  });

  it("calls onRefresh when clicking RefreshCw", async () => {
    const onRefresh = vi.fn();
    await renderHeader({ onRefresh });

    const refreshBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Reload Live Preview"]')!;
    await act(async () => {
      refreshBtn.click();
    });

    expect(onRefresh).toHaveBeenCalled();
  });

  it("toggles device selector dropdown and changes mode to tablet and mobile", async () => {
    const setDeviceMode = vi.fn();
    await renderHeader({ setDeviceMode });

    const deviceBtn = host.querySelector<HTMLButtonElement>(".preview-header-device-btn")!;
    await act(async () => {
      deviceBtn.click();
    });

    const menuItems = host.querySelectorAll<HTMLButtonElement>(".preview-header-menu-item");
    expect(menuItems.length).toBe(3);

    // Click tablet
    await act(async () => {
      menuItems[1]?.click();
    });
    expect(setDeviceMode).toHaveBeenCalledWith("tablet");

    // Click mobile
    await act(async () => {
      deviceBtn.click();
    });
    const menuItems2 = host.querySelectorAll<HTMLButtonElement>(".preview-header-menu-item");
    await act(async () => {
      menuItems2[2]?.click();
    });
    expect(setDeviceMode).toHaveBeenCalledWith("mobile");
  });

  it("navigates to code workspace and terminal", async () => {
    await renderHeader({ projectFramework: "HTML/CSS", codeWorkspaceUrl: "/settings/code/comp1/proj1?session=session1" });

    const codeBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Open project code"]')!;
    await act(async () => {
      codeBtn.click();
    });
    expect(mockNavigate).toHaveBeenCalledWith("/settings/code/comp1/proj1?session=session1&view=files&file=index.html");

    const terminalBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Open project terminal"]')!;
    await act(async () => {
      terminalBtn.click();
    });
    expect(mockNavigate).toHaveBeenCalledWith("/settings/code/comp1/proj1?tab=terminal");
  });

  it("copies preview URL to clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    await renderHeader({ previewUrl: "http://example.com/live" });
    const copyBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Copy preview link"]')!;

    await act(async () => {
      copyBtn.click();
    });

    expect(writeText).toHaveBeenCalledWith("http://example.com/live");
  });

  it("toggles fullscreen and calls onClose", async () => {
    const setIsFullscreen = vi.fn();
    const onClose = vi.fn();
    await renderHeader({ setIsFullscreen, onClose });

    const maxBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Maximize"]')!;
    await act(async () => {
      maxBtn.click();
    });
    expect(setIsFullscreen).toHaveBeenCalled();

    const closeBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Close preview"]')!;
    await act(async () => {
      closeBtn.click();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("displays Ukrainian labels and tooltips when isUk is true", async () => {
    await renderHeader({ isUk: true });

    expect(host.querySelector('header[aria-label="Панель керування Live Preview"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Оновити Live Preview"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Розмір екрана"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Відкрити код проєкту"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Відкрити термінал проєкту"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Скопіювати посилання"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="На весь екран"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Закрити перегляд"]')).not.toBeNull();
  });
});
