import {expect,it} from 'vitest';
import {resolveConversationLanguage} from '../apps/agent-api/src/company-chat-i18n';
const transliteration=[
 ['uk','Створи компанію з головним агентом.','dodai tsil «X» dlia biznesu «X»: 50 novykh kliientiv do kintsia 2026'],
 ['ru','Создай компанию с главным агентом.','dobav tsel «X» dlya biznesa «X»: 50 novykh klientov do kontsa 2026'],
 ['zh','创建一家公司并添加主要智能体。','gei yewu「X」tianjia mubiao「X」：2026 nian di qian 50 ge xin kehu'],
 ['ja','会社を作成してメインエージェントを追加してください。','bijinesu「X」ni mokuhyou「X」wo tsuika shite: 2026nen matsu made ni shinki kokyaku 50'],
 ['ko','회사를 만들고 메인 에이전트를 추가해 주세요.','bijeuniseu 「X」e mokpyo 「X」 chuga: 2026nyeon malkkaji singyu gogaek 50myeong'],
 ['ar','أنشئ شركة مع وكيل رئيسي.','adif hadaf «X» lil nashat «X»: 50 3amil jadid qabl nihayat 2026'],
 ['hi','मुख्य एजेंट के साथ कंपनी बनाएं।','business «X» mein goal «X» add karo: 2026 ke end tak 50 naye customers'],
];
it.each(transliteration)('preserves active %s for low-confidence transliteration',(language,prior,message)=>expect(resolveConversationLanguage(message,[{role:'user',content:prior}])).toBe(language));
it.each([['en','Please continue with the next step.'],['es','Cambia su rol a «Lead».'],['ru','Поменяй ему роль на «Lead».'],['zh','把它的角色改成负责人。'],['ja','その役割を変更してください。']])('still switches to a confident %s request across scripts',(language,message)=>expect(resolveConversationLanguage(message,[{role:'user',content:'أنشئ شركة مع وكيل رئيسي.'}])).toBe(language));
