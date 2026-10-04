import { DataStudioError } from "./identifier";

export interface ProjectEmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  type: "verification" | "password_reset";
  token: string;
}

export interface EmailProvider {
  sendVerificationEmail(to: string, token: string, userEmail: string): Promise<void>;
  sendPasswordResetEmail(to: string, token: string, userEmail: string): Promise<void>;
}

export class UnconfiguredEmailProvider implements EmailProvider {
  async sendVerificationEmail(_to: string, _token: string, _userEmail: string): Promise<void> {
    throw new DataStudioError(
      503,
      "email_service",
      "EMAIL_SERVICE_UNCONFIGURED: Email service is not configured for this project. Cannot send verification email.",
      false,
      "EMAIL_SERVICE_UNCONFIGURED",
    );
  }

  async sendPasswordResetEmail(_to: string, _token: string, _userEmail: string): Promise<void> {
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

  async sendVerificationEmail(to: string, token: string, userEmail: string): Promise<void> {
    this.sentMessages.push({
      to,
      subject: "Verify your email address",
      text: `Welcome! Please verify your email using this token: ${token}`,
      html: `<p>Welcome! Please verify your email using this token: <strong>${token}</strong></p>`,
      type: "verification",
      token,
    });
  }

  async sendPasswordResetEmail(to: string, token: string, userEmail: string): Promise<void> {
    this.sentMessages.push({
      to,
      subject: "Reset your password",
      text: `You requested a password reset. Use this token: ${token}`,
      html: `<p>You requested a password reset. Use this token: <strong>${token}</strong></p>`,
      type: "password_reset",
      token,
    });
  }

  clear(): void {
    this.sentMessages.length = 0;
  }
}
