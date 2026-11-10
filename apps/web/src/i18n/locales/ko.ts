import type { TranslationSchema } from "../types";
import { core } from "./ko/core";
import { business } from "./ko/business";
import { activity } from "./ko/activity";
import { email } from "./ko/email";
import { workspace } from "./ko/workspace";
import { integrations } from "./ko/integrations";

export const ko: TranslationSchema = {
  ...core,
  ...business,
  ...activity,
  ...email,
  ...workspace,
  ...integrations,
};
