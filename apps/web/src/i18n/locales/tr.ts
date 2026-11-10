import type { TranslationSchema } from "../types";
import { core } from "./tr/core";
import { business } from "./tr/business";
import { activity } from "./tr/activity";
import { email } from "./tr/email";
import { workspace } from "./tr/workspace";
import { integrations } from "./tr/integrations";

export const tr: TranslationSchema = {
  ...core,
  ...business,
  ...activity,
  ...email,
  ...workspace,
  ...integrations,
};
