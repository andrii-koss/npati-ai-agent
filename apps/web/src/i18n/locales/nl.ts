import type { TranslationSchema } from "../types";
import { core } from "./nl/core";
import { business } from "./nl/business";
import { activity } from "./nl/activity";
import { email } from "./nl/email";
import { workspace } from "./nl/workspace";
import { integrations } from "./nl/integrations";

export const nl: TranslationSchema = {
  ...core,
  ...business,
  ...activity,
  ...email,
  ...workspace,
  ...integrations,
};
