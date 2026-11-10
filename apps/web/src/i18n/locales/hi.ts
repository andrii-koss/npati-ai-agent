import type { TranslationSchema } from "../types";
import { core } from "./hi/core";
import { business } from "./hi/business";
import { activity } from "./hi/activity";
import { email } from "./hi/email";
import { workspace } from "./hi/workspace";
import { integrations } from "./hi/integrations";

export const hi: TranslationSchema = {
  ...core,
  ...business,
  ...activity,
  ...email,
  ...workspace,
  ...integrations,
};
