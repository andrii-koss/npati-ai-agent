import type { TranslationSchema } from "../types";
import { core } from "./pt/core";
import { business } from "./pt/business";
import { activity } from "./pt/activity";
import { email } from "./pt/email";
import { workspace } from "./pt/workspace";
import { integrations } from "./pt/integrations";

export const pt: TranslationSchema = {
  ...core,
  ...business,
  ...activity,
  ...email,
  ...workspace,
  ...integrations,
};
