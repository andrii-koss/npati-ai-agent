import { expect, it } from "vitest";
import { resolveCodingConversationLanguage, chatLanguageInstruction } from "../apps/agent-api/src/company-chat-i18n";
it.each([
 ["\u0421\u0442\u0432\u043e\u0440\u0438 \u0442\u0435\u0441\u0442\u043e\u0432\u0438\u0439 \u0441\u0430\u0439\u0442 \u043d\u0430 Next.js, \u0432\u0441\u0442\u0430\u043d\u043e\u0432\u0438 \u0437\u0430\u043b\u0435\u0436\u043d\u043e\u0441\u0442\u0456, \u0437\u0430\u043f\u0443\u0441\u0442\u0438 build \u0456 Live Preview.","uk"],
 ["Please change the header to green and check the website","en"],
 ["Bitte erstellen Sie die Startseite und erkl\u00e4ren Sie die vorgenommenen \u00c4nderungen","de"],
 ["Por favor, altere o site e explique as mudan\u00e7as realizadas em portugu\u00eas","pt"]
])("passes request language rather than tool language: %s",(message,language)=>{
 const actual=resolveCodingConversationLanguage(message);expect(actual).toBe(language);expect(chatLanguageInstruction(message,[],actual)).toContain("("+language+")");
});
it("uses the conversation for short confirmations and technical-only requests",()=>{
 const history=[{role:"user",content:"\u0421\u0442\u0432\u043e\u0440\u0438 \u043c\u0435\u043d\u0456 \u0441\u0430\u0439\u0442 \u043c\u0430\u0433\u0430\u0437\u0438\u043d\u0443 \u0442\u0430 \u043f\u043e\u044f\u0441\u043d\u0438 \u0432\u0441\u0456 \u0437\u043c\u0456\u043d\u0438"},{role:"assistant",content:"English technical log npm run build"}];
 for(const message of ["\u0442\u0430\u043a","npm run build","app/page.tsx"])expect(resolveCodingConversationLanguage(message,history)).toBe("uk");
});
