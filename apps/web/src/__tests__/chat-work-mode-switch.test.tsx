// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ChatWorkModeSwitch, BusinessChatComposer } from "../business-workspace-composer";

describe("ChatWorkModeSwitch", () => {
  it("renders compact Soft UI switch with Chat and Code buttons and handles switching", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const onChange = vi.fn();
    await act(async () => {
      root.render(<ChatWorkModeSwitch mode="chat" onChange={onChange} />);
    });

    const switcher = container.querySelector(".chat-work-mode-switch");
    expect(switcher).not.toBeNull();
    expect(switcher?.getAttribute("data-mode")).toBe("chat");

    const thumb = container.querySelector(".chat-work-mode-thumb");
    expect(thumb).not.toBeNull();
    expect(thumb?.classList.contains("chat")).toBe(true);

    const buttons = container.querySelectorAll<HTMLButtonElement>(".chat-work-mode-btn");
    expect(buttons).toHaveLength(2);

    // Chat button is active
    expect(buttons[0]?.getAttribute("title")).toBe("Chat");
    expect(buttons[0]?.getAttribute("aria-checked")).toBe("true");
    expect(buttons[0]?.classList.contains("active")).toBe(true);
    expect(buttons[0]?.querySelector("svg")).not.toBeNull();

    // Code button is inactive
    expect(buttons[1]?.getAttribute("title")).toBe("Code");
    expect(buttons[1]?.getAttribute("aria-checked")).toBe("false");
    expect(buttons[1]?.classList.contains("active")).toBe(false);

    // Click Code button
    await act(async () => {
      buttons[1]?.click();
    });
    expect(onChange).toHaveBeenCalledWith("code");

    // Re-render in code mode
    await act(async () => {
      root.render(<ChatWorkModeSwitch mode="code" onChange={onChange} />);
    });
    expect(thumb?.classList.contains("code")).toBe(true);
    expect(buttons[1]?.classList.contains("active")).toBe(true);
    expect(buttons[0]?.classList.contains("active")).toBe(false);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("renders in the chat composer input bar right before the microphone button", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const props: any = {
      input: "",
      setInput: () => {},
      attachments: [],
      setAttachments: () => {},
      draftVersion: { current: 0 },
      sending: false,
      codeInbox: { active: false },
      inboxSubmitting: false,
      contextSwitcher: null,
      noMemory: false,
      ttsEnabled: false,
      chatMode: "none",
      handleModeChange: () => {},
      ttsVoice: "",
      handleTtsVoiceChange: () => {},
      generateSpeechForInput: async () => {},
      isGeneratingSpeech: false,
      sendOnEnter: () => {},
      submit: async () => {},
      business: null,
      t: (key: string) => key,
      setNotice: () => {},
      streamControllerRef: { current: null },
      workMode: "chat",
      onWorkModeChange: () => {},
      projectSelected: false,
    };

    await act(async () => {
      root.render(<BusinessChatComposer {...props} />);
    });

    const actionsRight = container.querySelector(".chat-attachment-actions-right");
    expect(actionsRight).not.toBeNull();

    // Verify switch is immediately before the microphone button
    const switcher = actionsRight?.querySelector(".chat-work-mode-switch");
    const mic = actionsRight?.querySelector(".microphone");
    expect(switcher).not.toBeNull();
    expect(mic).not.toBeNull();
    expect(switcher?.nextElementSibling).toBe(mic);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
