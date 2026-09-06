import { describe, expect, it } from "vitest";
import {
  BrowserTabController,
  BrowserClickTypeEngine,
  BrowserDragSelectEngine,
} from "../apps/agent-api/src/browser-automation-controller";

describe("Browser Tab Controller (BrowserTabController)", () => {
  it("opens, navigates, switches, and closes browser tabs", () => {
    const controller = new BrowserTabController();

    const tab1 = controller.openTab("https://npati.ai", "NPATI AI Home");
    expect(tab1.isActive).toBe(true);
    expect(controller.listTabs().length).toBe(1);

    const tab2 = controller.openTab("https://docs.npati.ai", "Docs");
    expect(tab2.isActive).toBe(true);
    expect(controller.getActiveTab()?.tabId).toBe(tab2.tabId);

    // Switch back to tab1
    controller.switchTab(tab1.tabId);
    expect(controller.getActiveTab()?.tabId).toBe(tab1.tabId);

    // Navigate
    controller.navigateTab(tab1.tabId, "https://npati.ai/dashboard", "Dashboard");
    expect(controller.getActiveTab()?.url).toBe("https://npati.ai/dashboard");
    expect(controller.getActiveTab()?.history.length).toBe(2);

    // Close tab2
    controller.closeTab(tab2.tabId);
    expect(controller.listTabs().length).toBe(1);
  });
});

describe("Browser Click & Type Engine (BrowserClickTypeEngine)", () => {
  it("clicks buttons, types into inputs, and submits forms", () => {
    const controller = new BrowserTabController();
    const tab = controller.openTab("https://npati.ai/login");

    const clickRes = BrowserClickTypeEngine.click(tab, "#login-btn", { button: "left" });
    expect(clickRes.success).toBe(true);
    expect(clickRes.action).toBe("click");

    const typeRes = BrowserClickTypeEngine.type(tab, "input[name='email']", "admin@npati.ai");
    expect(typeRes.success).toBe(true);
    expect(typeRes.details?.typedText).toBe("admin@npati.ai");

    const submitRes = BrowserClickTypeEngine.submit(tab, "#login-form");
    expect(submitRes.success).toBe(true);
    expect(submitRes.action).toBe("submit");
  });
});

describe("Browser Drag, Select & Scroll Engine (BrowserDragSelectEngine)", () => {
  it("executes drag and drop, option select, and scroll operations", () => {
    const controller = new BrowserTabController();
    const tab = controller.openTab("https://npati.ai/canvas");

    const dragRes = BrowserDragSelectEngine.dragAndDrop(tab, "#node-1", "#node-2");
    expect(dragRes.success).toBe(true);
    expect(dragRes.action).toBe("drag_and_drop");

    const selectRes = BrowserDragSelectEngine.selectOption(tab, "select#model-selector", "gpt-4o");
    expect(selectRes.success).toBe(true);
    expect(selectRes.details?.selectedOption).toBe("gpt-4o");

    const scrollRes = BrowserDragSelectEngine.scroll(tab, { y: 500 });
    expect(scrollRes.success).toBe(true);
    expect(scrollRes.action).toBe("scroll");
  });
});
