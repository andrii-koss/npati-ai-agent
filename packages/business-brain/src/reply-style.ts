/**
 * Decorative emoji are removed from chat replies unless the person used or asked for them. Models added 🥖 📍 🍞 to
 * plain answers ("На нічній зміні пече Тарас. 🥖"); the owner treats that as noise (V6 step 14). Text symbols such as
 * ★ (the main-agent marker), ✔ and © are kept: only pictographs drawn as colour emoji are removed.
 */
const EMOJI = String.raw`(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️)(?:‍(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️?))*[\u{1F3FB}-\u{1F3FF}]?`;
const WANTS_EMOJI = /(?:emoji|emoticon|smiley|емодзі|емоджі|смайл|эмодзи)/iu;

export function stripDecorativeEmoji(reply: string, userMessage = ""): string {
  const present = new RegExp(EMOJI, "u");
  if (!present.test(reply) || present.test(userMessage) || WANTS_EMOJI.test(userMessage)) return reply;
  const emojiWithSpace = new RegExp(EMOJI + "[ \\t]?", "gu");
  // Code blocks keep their bytes; prose loses the pictographs and the space each one left behind.
  return reply.split(/(```[\s\S]*?```)/u).map((part, index) => index % 2 ? part : part
    .replace(emojiWithSpace, "")
    .replace(/[ \t]+([.,!?:;])/g, "$1")
    .replace(/[ \t]+$/gm, "")).join("").trim();
}
