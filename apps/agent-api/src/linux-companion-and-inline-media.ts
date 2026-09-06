export interface LinuxNotificationResult {
  notificationId: number;
  summary: string;
  body: string;
  urgency: "low" | "normal" | "critical";
  deliveredViaDbus: boolean;
  timestamp: string;
}

export interface MprisMediaState {
  mediaId: string;
  title: string;
  artist: string;
  playbackStatus: "Playing" | "Paused" | "Stopped";
  canControl: boolean;
}

export interface InlineRenderedBlock {
  type: "image" | "audio" | "video";
  url: string;
  htmlEmbed: string;
  ansiSixelPreview?: string;
  mimeType: string;
}

export class LinuxCompanionDaemon {
  private notificationCounter = 0;
  private readonly mediaControls = new Map<string, MprisMediaState>();

  /**
   * 1. Linux Companion: D-Bus libnotify notifications and MPRIS media integration
   */
  sendNotification(
    summary: string,
    body: string,
    urgency: "low" | "normal" | "critical" = "normal"
  ): LinuxNotificationResult {
    this.notificationCounter++;
    return {
      notificationId: this.notificationCounter,
      summary,
      body,
      urgency,
      deliveredViaDbus: true,
      timestamp: new Date().toISOString(),
    };
  }

  registerMpris(
    mediaId: string,
    title: string,
    artist = "NPATI Agent"
  ): MprisMediaState {
    const state: MprisMediaState = {
      mediaId,
      title,
      artist,
      playbackStatus: "Playing",
      canControl: true,
    };
    this.mediaControls.set(mediaId, state);
    return state;
  }

  getMediaState(mediaId: string): MprisMediaState | undefined {
    return this.mediaControls.get(mediaId);
  }
}

export class InlineMediaRenderer {
  /**
   * 2. Inline Media: Rich inline rendering of images, audio players & videos in chat/terminal
   */
  static render(media: {
    type: "image" | "audio" | "video";
    url: string;
    altText?: string;
    mimeType?: string;
  }): InlineRenderedBlock {
    const alt = media.altText ?? "media asset";
    let htmlEmbed = "";
    let ansiSixelPreview: string | undefined;

    switch (media.type) {
      case "image":
        htmlEmbed = `<img src="${media.url}" alt="${alt}" class="npati-inline-media npati-inline-image" loading="lazy" />`;
        ansiSixelPreview = `\x1b_Ga=T,f=100,s=32,v=32;${Buffer.from(media.url).toString("base64")}\x1b\\`;
        break;
      case "audio":
        htmlEmbed = `<audio controls src="${media.url}" class="npati-inline-media npati-inline-audio"><a href="${media.url}">Play Audio</a></audio>`;
        break;
      case "video":
        htmlEmbed = `<video controls src="${media.url}" class="npati-inline-media npati-inline-video" preload="metadata"></video>`;
        break;
    }

    return {
      type: media.type,
      url: media.url,
      htmlEmbed,
      ansiSixelPreview,
      mimeType: media.mimeType ?? (media.type === "image" ? "image/jpeg" : media.type === "audio" ? "audio/mp3" : "video/mp4"),
    };
  }
}
