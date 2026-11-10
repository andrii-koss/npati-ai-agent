import type { TranslationSchema } from "../types";
import { core } from "./ru/core";
import { business } from "./ru/business";
import { activity } from "./ru/activity";
import { email } from "./ru/email";
import { workspace } from "./ru/workspace";
import { integrations } from "./ru/integrations";

export const ru: TranslationSchema = {
  ...core,
  ...business,
  ...activity,
  ...email,
  ...workspace,
  ...integrations,
};
