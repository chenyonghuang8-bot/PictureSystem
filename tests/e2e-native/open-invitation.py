"""Deliver the owned real invitation through Android VIEW without logging its URI."""
import json,pathlib,subprocess,sys,time
root=pathlib.Path(__file__).resolve().parents[2]
c=json.loads((root/'.cache/phase10-native-tests/runtime.json').read_text())
adb='/Users/toby/Library/Android/sdk/platform-tools/adb'
if sys.argv[1]=='cold':subprocess.run([adb,'shell','am','force-stop','local.familyalbum.app.dev'],check=True,capture_output=True)
r=subprocess.run([adb,'shell','am','start','-a','android.intent.action.VIEW','-d',c['invitationURL'],'local.familyalbum.app.dev'],capture_output=True)
if r.returncode:print('REAL_INVITATION_VIEW_INTENT_FAILED');sys.exit(1)
time.sleep(2)
print('REAL_INVITATION_VIEW_INTENT_SENT_'+sys.argv[1].upper())
