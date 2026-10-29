import {expect,it} from 'vitest';
import {detectCompanyChatLanguage,resolveConversationLanguage} from '../apps/agent-api/src/company-chat-i18n';
const history=[{role:'user',content:'Add an agent to the company who handles customer support.'}];
it.each([['es','Cambia su rol a «Lead».'],['fr','Change son rôle en «Lead».']])('recognizes an unambiguous short %s request after English without matching business intent keywords',(language,message)=>expect(resolveConversationLanguage(message,history)).toBe(language));
it.each([['pl','nowa autom. «X», wstrzym., pon 9:00, tyg. raport sprzed.'],['pt','nova autom. «X», pausada, seg 9h, relat. semanal vendas'],['nl','nieuwe autom. «X», gepauzeerd, ma 9u, wkl. verkooprapp.']])('preserves longer abbreviated %s requests',(language,message)=>expect(detectCompanyChatLanguage(message)).toBe(language));
it('retains the active language for an ambiguous acknowledgment',()=>expect(resolveConversationLanguage('ok',[{role:'user',content:'Створи компанію з головним агентом.'}])).toBe('uk'));
