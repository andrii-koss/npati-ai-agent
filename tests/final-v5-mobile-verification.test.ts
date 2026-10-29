import {expect,it} from 'vitest';
import {detectToolchain,TOOLCHAIN_MANIFEST_FILES} from '../apps/agent-api/src/code-toolchain-detector';
import {isCodeChatWebsite} from '../apps/agent-api/src/code-chat-website';
it('detects current Flutter manifests and real static/unit commands',()=>{
 expect(TOOLCHAIN_MANIFEST_FILES).toContain('pubspec.yaml');
 const result=detectToolchain({files:{'pubspec.yaml':'name: app\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n'}});
 expect(result.languages).toContain('dart');expect(result.verifyCommands).toMatchObject({lint:'flutter analyze',test:'flutter test'});
 expect(result.verifyCommands.build).toBeUndefined(); // Native build must be explicitly requested with its toolchain.
});
it('does not require web Preview for native mobile completion',()=>{
 expect(isCodeChatWebsite({type:'mobile_app',framework:'Expo'})).toBe(false);
 expect(isCodeChatWebsite({type:'mobile_app',framework:'Flutter'})).toBe(false);
 expect(isCodeChatWebsite({type:'code_project',framework:'React + Vite'})).toBe(true);
});
