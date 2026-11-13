/**
 * The Goals and Memory pages show the user's current Business, which a chat about another company does not change. A
 * card link written for one Business carries its id, so "Open in business goals" opens that Business, not whichever
 * one the user had last (V6 step 11: the goal was created for V6TEST_Bakery2 and the link showed V6TEST_Flowers empty).
 */
export function scopeBusinessPageLinks(text: string, businessId: string | undefined, pages: Array<"goals" | "memory"> = ["goals", "memory"]): string {
  if (!businessId) return text;
  const query = "?business=" + encodeURIComponent(businessId);
  return pages.reduce((out, page) => out.split(`](/settings/${page})`).join(`](/settings/${page}${query})`), text);
}
