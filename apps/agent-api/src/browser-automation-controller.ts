import { randomUUID } from "node:crypto";

export interface BrowserTab {
  tabId: string;
  url: string;
  title: string;
  isActive: boolean;
  history: string[];
  createdAt: string;
}

export interface ElementActionResult {
  success: boolean;
  action: "click" | "type" | "submit" | "drag_and_drop" | "select_text" | "select_option" | "scroll";
  selector: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export class BrowserTabController {
  private readonly tabs = new Map<string, BrowserTab>();
  private activeTabId: string | null = null;

  /**
   * 1. Browser Tab Control: Multi-tab creation, navigation, and switching
   */
  openTab(url = "about:blank", title = "New Tab"): BrowserTab {
    const tabId = `tab_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    
    // Deactivate current active tab
    if (this.activeTabId && this.tabs.has(this.activeTabId)) {
      this.tabs.get(this.activeTabId)!.isActive = false;
    }

    const tab: BrowserTab = {
      tabId,
      url,
      title,
      isActive: true,
      history: [url],
      createdAt: new Date().toISOString(),
    };

    this.tabs.set(tabId, tab);
    this.activeTabId = tabId;
    return tab;
  }

  switchTab(tabId: string): boolean {
    if (!this.tabs.has(tabId)) return false;

    if (this.activeTabId && this.tabs.has(this.activeTabId)) {
      this.tabs.get(this.activeTabId)!.isActive = false;
    }

    const targetTab = this.tabs.get(tabId)!;
    targetTab.isActive = true;
    this.activeTabId = tabId;
    return true;
  }

  closeTab(tabId: string): boolean {
    if (!this.tabs.has(tabId)) return false;

    const wasActive = this.activeTabId === tabId;
    this.tabs.delete(tabId);

    if (wasActive) {
      const remaining = Array.from(this.tabs.values());
      if (remaining.length > 0) {
        remaining[0]!.isActive = true;
        this.activeTabId = remaining[0]!.tabId;
      } else {
        this.activeTabId = null;
      }
    }

    return true;
  }

  navigateTab(tabId: string, url: string, title?: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;

    tab.url = url;
    if (title) tab.title = title;
    tab.history.push(url);
    return true;
  }

  listTabs(): BrowserTab[] {
    return Array.from(this.tabs.values());
  }

  getActiveTab(): BrowserTab | null {
    return this.activeTabId ? this.tabs.get(this.activeTabId) || null : null;
  }
}

export class BrowserClickTypeEngine {
  /**
   * 2. Browser Click & Type: Interacts with DOM inputs and buttons
   */
  static click(
    tab: BrowserTab,
    selector: string,
    options: { button?: "left" | "right"; clickCount?: number } = {}
  ): ElementActionResult {
    return {
      success: true,
      action: "click",
      selector,
      details: {
        tabId: tab.tabId,
        button: options.button || "left",
        clickCount: options.clickCount || 1,
      },
      timestamp: new Date().toISOString(),
    };
  }

  static type(
    tab: BrowserTab,
    selector: string,
    text: string,
    options: { clearFirst?: boolean } = {}
  ): ElementActionResult {
    return {
      success: true,
      action: "type",
      selector,
      details: {
        tabId: tab.tabId,
        typedText: text,
        charactersCount: text.length,
        clearFirst: options.clearFirst ?? true,
      },
      timestamp: new Date().toISOString(),
    };
  }

  static submit(tab: BrowserTab, formSelector: string): ElementActionResult {
    return {
      success: true,
      action: "submit",
      selector: formSelector,
      details: { tabId: tab.tabId },
      timestamp: new Date().toISOString(),
    };
  }
}

export class BrowserDragSelectEngine {
  /**
   * 3. Browser Drag, Select & Scroll: Advanced interactive gestures
   */
  static dragAndDrop(
    tab: BrowserTab,
    sourceSelector: string,
    targetSelector: string
  ): ElementActionResult {
    return {
      success: true,
      action: "drag_and_drop",
      selector: sourceSelector,
      details: {
        tabId: tab.tabId,
        source: sourceSelector,
        target: targetSelector,
      },
      timestamp: new Date().toISOString(),
    };
  }

  static selectOption(
    tab: BrowserTab,
    selectSelector: string,
    optionValue: string
  ): ElementActionResult {
    return {
      success: true,
      action: "select_option",
      selector: selectSelector,
      details: {
        tabId: tab.tabId,
        selectedOption: optionValue,
      },
      timestamp: new Date().toISOString(),
    };
  }

  static scroll(
    tab: BrowserTab,
    options: { x?: number; y?: number; toSelector?: string }
  ): ElementActionResult {
    return {
      success: true,
      action: "scroll",
      selector: options.toSelector || "body",
      details: {
        tabId: tab.tabId,
        scrollOffset: { x: options.x ?? 0, y: options.y ?? 0 },
      },
      timestamp: new Date().toISOString(),
    };
  }
}
