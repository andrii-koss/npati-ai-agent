import { DataStudioError } from "./identifier";

export interface ProjectEmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  type: "verification" | "password_reset";
  token: string;
  /** Absolute deep link (mobile app scheme or web URL) when a redirect target was registered. */
  link?: string;
}

/** Optional deep link built from the project's registered redirect URLs (D6). */
export interface ProjectEmailOptions {
  link?: string;
}

export interface EmailProvider {
  sendVerificationEmail(to: string, token: string, userEmail: string, options?: ProjectEmailOptions): Promise<void>;
  sendPasswordResetEmail(to: string, token: string, userEmail: string, options?: ProjectEmailOptions): Promise<void>;
}

export class UnconfiguredEmailProvider implements EmailProvider {
  async sendVerificationEmail(_to: string, _token: string, _userEmail: string, _options?: ProjectEmailOptions): Promise<void> {
    throw new DataStudioError(
      503,
      "email_service",
      "EMAIL_SERVICE_UNCONFIGURED: Email service is not configured for this project. Cannot send verification email.",
      false,
      "EMAIL_SERVICE_UNCONFIGURED",
    );
  }

  async sendPasswordResetEmail(_to: string, _token: string, _userEmail: string, _options?: ProjectEmailOptions): Promise<void> {
    throw new DataStudioError(
      503,
      "email_service",
      "EMAIL_SERVICE_UNCONFIGURED: Email service is not configured for this project. Cannot send password reset email.",
      false,
      "EMAIL_SERVICE_UNCONFIGURED",
    );
  }
}

export class MockEmailProvider implements EmailProvider {
  readonly sentMessages: ProjectEmailMessage[] = [];

  get sentEmails(): ProjectEmailMessage[] {
    return this.sentMessages;
  }

  set sentEmails(messages: ProjectEmailMessage[]) {
    this.sentMessages.length = 0;
    this.sentMessages.push(...messages);
  }

  async sendVerificationEmail(to: string, token: string, userEmail: string, options?: ProjectEmailOptions): Promise<void> {
    this.sentMessages.push({
      to,
      subject: "Verify your email address",
      text: options?.link
        ? `Welcome! Please verify your email using this link: ${options.link}`
        : `Welcome! Please verify your email using this token: ${token}`,
      html: options?.link
        ? `<p>Welcome! Please verify your email: <a href="${options.link}">verify email</a></p>`
        : `<p>Welcome! Please verify your email using this token: <strong>${token}</strong></p>`,
      type: "verification",
      token,
      link: options?.link,
    });
  }

  async sendPasswordResetEmail(to: string, token: string, userEmail: string, options?: ProjectEmailOptions): Promise<void> {
    this.sentMessages.push({
      to,
      subject: "Reset your password",
      text: options?.link
        ? `You requested a password reset. Open this link in the app: ${options.link}`
        : `You requested a password reset. Use this token: ${token}`,
      html: options?.link
        ? `<p>You requested a password reset: <a href="${options.link}">reset password</a></p>`
        : `<p>You requested a password reset. Use this token: <strong>${token}</strong></p>`,
      type: "password_reset",
      token,
      link: options?.link,
    });
  }

  clear(): void {
    this.sentMessages.length = 0;
  }
}
