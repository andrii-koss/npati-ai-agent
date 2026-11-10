import type { TranslationSchema } from "../types";
import { core } from "./zh/core";
import { business } from "./zh/business";
import { activity } from "./zh/activity";
import { email } from "./zh/email";
import { workspace } from "./zh/workspace";
import { integrations } from "./zh/integrations";

export const zh: TranslationSchema = {
  ...core,
  ...business,
  ...activity,
  ...email,
  ...workspace,
  ...integrations,
};
