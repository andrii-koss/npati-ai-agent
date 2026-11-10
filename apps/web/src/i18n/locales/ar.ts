import type { TranslationSchema } from "../types";
import { core } from "./ar/core";
import { business } from "./ar/business";
import { activity } from "./ar/activity";
import { email } from "./ar/email";
import { workspace } from "./ar/workspace";
import { integrations } from "./ar/integrations";

export const ar: TranslationSchema = {
  ...core,
  ...business,
  ...activity,
  ...email,
  ...workspace,
  ...integrations,
};
