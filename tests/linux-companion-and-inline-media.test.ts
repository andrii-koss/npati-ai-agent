import { describe, expect, it } from "vitest";
import {
  LinuxCompanionDaemon,
  InlineMediaRenderer,
} from "../apps/agent-api/src/linux-companion-and-inline-media";

describe("Linux Companion Daemon (Linux companion)", () => {
  it("delivers D-Bus desktop notifications and registers MPRIS media status", () => {
    const daemon = new LinuxCompanionDaemon();

    const notif = daemon.sendNotification(
      "NPATI Task Completed",
      "Benchmark pgvector finished with latency < 150ms.",
      "critical"
    );

    expect(notif.deliveredViaDbus).toBe(true);
    expect(notif.urgency).toBe("critical");
    expect(notif.notificationId).toBe(1);

    const mpris = daemon.registerMpris("media-track-99", "Synthetic Soundscape", "AI Orchestra");
    expect(mpris.playbackStatus).toBe("Playing");
    expect(daemon.getMediaState("media-track-99")?.title).toBe("Synthetic Soundscape");
  });
});

describe("Inline Media Renderer (inline media)", () => {
  it("renders inline HTML embeds and ANSI terminal sixel previews for multimedia assets", () => {
    // 1. Image
    const img = InlineMediaRenderer.render({
      type: "image",
      url: "https://cdn.npati.io/images/preview.png",
      altText: "Architecture Diagram",
      mimeType: "image/png",
    });
    expect(img.htmlEmbed).toContain("<img src=");
    expect(img.ansiSixelPreview).toContain("\x1b_G");
    expect(img.mimeType).toBe("image/png");

    // 2. Audio
    const audio = InlineMediaRenderer.render({
      type: "audio",
      url: "https://cdn.npati.io/audio/voice.mp3",
    });
    expect(audio.htmlEmbed).toContain("<audio controls");

    // 3. Video
    const video = InlineMediaRenderer.render({
      type: "video",
      url: "https://cdn.npati.io/video/demo.mp4",
    });
    expect(video.htmlEmbed).toContain("<video controls");
  });
});
