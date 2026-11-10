import type { TranslationSchema } from "../types";
import { core } from "./ja/core";
import { business } from "./ja/business";
import { activity } from "./ja/activity";
import { email } from "./ja/email";
import { workspace } from "./ja/workspace";
import { integrations } from "./ja/integrations";

export const ja: TranslationSchema = {
  ...core,
  ...business,
  ...activity,
  ...email,
  ...workspace,
  ...integrations,
};
