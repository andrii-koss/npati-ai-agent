import { randomUUID } from "node:crypto";
import { BrowserSecurityGuard } from "./browser-security-guard";

export interface BrowserTab {
  tabId: string;
  url: string;
  title: string;
  isActive: boolean;
  history: string[];
  createdAt: string;
  profileId?: string;
  tenantId?: string;
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
   * 1. Browser Tab Control: Multi-tab creation, navigation, and switching with SSRF protection
   */
  openTab(
    url = "about:blank",
    title = "New Tab",
    options: { profileId?: string; tenantId?: string; allowLocalhost?: boolean } = {}
  ): BrowserTab {
    if (url !== "about:blank") {
      const validation = BrowserSecurityGuard.validateUrl(url, {
        allowLocalhost: options.allowLocalhost,
      });
      if (!validation.allowed) {
        throw new Error(`SSRF_BLOCKED: ${validation.reason}`);
      }
    }

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
      profileId: options.profileId,
      tenantId: options.tenantId,
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

  navigateTab(
    tabId: string,
    url: string,
    title?: string,
    options: { allowLocalhost?: boolean } = {}
  ): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;

    if (url !== "about:blank") {
      const validation = BrowserSecurityGuard.validateUrl(url, {
        allowLocalhost: options.allowLocalhost,
      });
      if (!validation.allowed) {
        throw new Error(`SSRF_BLOCKED: ${validation.reason}`);
      }
    }

    tab.url = url;
    if (title) tab.title = title;
    tab.history.push(url);
    return true;
  }

  getTab(tabId: string): BrowserTab | null {
    return this.tabs.get(tabId) || null;
  }

  listTabs(tenantId?: string): BrowserTab[] {
    const all = Array.from(this.tabs.values());
    if (!tenantId) return all;
    return all.filter((t) => !t.tenantId || t.tenantId === tenantId);
  }

  getActiveTab(): BrowserTab | null {
    return this.activeTabId ? this.tabs.get(this.activeTabId) || null : null;
  }
}

export class BrowserClickTypeEngine {
  /**
   * 2. Browser Click & Type: Interacts with DOM inputs and buttons with Destructive Action Risk Guard
   */
  static click(
    tab: BrowserTab,
    selector: string,
    options: { button?: "left" | "right"; clickCount?: number; approved?: boolean } = {}
  ): ElementActionResult {
    const risk = BrowserSecurityGuard.checkActionRisk("click", selector);
    if (risk.highRisk && !options.approved) {
      throw new Error(`APPROVAL_REQUIRED: ${risk.reason}`);
    }

    return {
      success: true,
      action: "click",
      selector,
      details: {
        tabId: tab.tabId,
        button: options.button || "left",
        clickCount: options.clickCount || 1,
        highRisk: risk.highRisk,
        approved: Boolean(options.approved),
      },
      timestamp: new Date().toISOString(),
    };
  }

  static type(
    tab: BrowserTab,
    selector: string,
    text: string,
    options: { clearFirst?: boolean; approved?: boolean } = {}
  ): ElementActionResult {
    const risk = BrowserSecurityGuard.checkActionRisk("type", selector);
    if (risk.highRisk && !options.approved) {
      throw new Error(`APPROVAL_REQUIRED: ${risk.reason}`);
    }

    return {
      success: true,
      action: "type",
      selector,
      details: {
        tabId: tab.tabId,
        typedText: text,
        charactersCount: text.length,
        clearFirst: options.clearFirst ?? true,
        highRisk: risk.highRisk,
        approved: Boolean(options.approved),
      },
      timestamp: new Date().toISOString(),
    };
  }

  static submit(
    tab: BrowserTab,
    formSelector: string,
    options: { approved?: boolean } = {}
  ): ElementActionResult {
    const risk = BrowserSecurityGuard.checkActionRisk("submit", formSelector);
    if (risk.highRisk && !options.approved) {
      throw new Error(`APPROVAL_REQUIRED: ${risk.reason}`);
    }

    return {
      success: true,
      action: "submit",
      selector: formSelector,
      details: {
        tabId: tab.tabId,
        highRisk: risk.highRisk,
        approved: Boolean(options.approved),
      },
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
    targetSelector: string,
    options: { approved?: boolean } = {}
  ): ElementActionResult {
    const sourceRisk = BrowserSecurityGuard.checkActionRisk("drag_and_drop", sourceSelector);
    const targetRisk = BrowserSecurityGuard.checkActionRisk("drag_and_drop", targetSelector);
    const highRisk = sourceRisk.highRisk || targetRisk.highRisk;

    if (highRisk && !options.approved) {
      const reason = sourceRisk.highRisk ? sourceRisk.reason : targetRisk.reason;
      throw new Error(`APPROVAL_REQUIRED: ${reason}`);
    }

    return {
      success: true,
      action: "drag_and_drop",
      selector: sourceSelector,
      details: {
        tabId: tab.tabId,
        source: sourceSelector,
        target: targetSelector,
        highRisk,
        approved: Boolean(options.approved),
      },
      timestamp: new Date().toISOString(),
    };
  }

  static selectOption(
    tab: BrowserTab,
    selectSelector: string,
    optionValue: string,
    options: { approved?: boolean } = {}
  ): ElementActionResult {
    const selectorRisk = BrowserSecurityGuard.checkActionRisk("select_option", selectSelector);
    const valueRisk = BrowserSecurityGuard.checkActionRisk("select_option", optionValue);
    const highRisk = selectorRisk.highRisk || valueRisk.highRisk;

    if (highRisk && !options.approved) {
      const reason = selectorRisk.highRisk ? selectorRisk.reason : valueRisk.reason;
      throw new Error(`APPROVAL_REQUIRED: ${reason}`);
    }

    return {
      success: true,
      action: "select_option",
      selector: selectSelector,
      details: {
        tabId: tab.tabId,
        selectedOption: optionValue,
        highRisk,
        approved: Boolean(options.approved),
      },
      timestamp: new Date().toISOString(),
    };
  }

  static scroll(
    tab: BrowserTab,
    options: { x?: number; y?: number; toSelector?: string } = {}
  ): ElementActionResult {
    const x = typeof options.x === "number" ? options.x : 0;
    const y = typeof options.y === "number" ? options.y : 0;
    const selector = options.toSelector || "window";

    return {
      success: true,
      action: "scroll",
      selector,
      details: {
        tabId: tab.tabId,
        scrollOffset: { x, y },
      },
      timestamp: new Date().toISOString(),
    };
  }
}
