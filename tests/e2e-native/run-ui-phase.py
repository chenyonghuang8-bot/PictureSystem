"""SDK instrumentation driver. Synthetic runtime credentials stay out of output."""
import subprocess,json,pathlib,sys
root=pathlib.Path(__file__).resolve().parents[2]
config=json.loads((root/'.cache/phase10-native-tests/runtime.json').read_text())
adb='/Users/toby/Library/Android/sdk/platform-tools/adb'
phase=sys.argv[1]
args=[adb,'-s','emulator-5554','shell','am','instrument','-w','-e','phase',phase,'-e','username',(config.get('invitedUsername') if phase=='invite-consume' else config['username']),'-e','password',config['password'],'-e','family',config['familyName'],'-e','file',config['fileName'],'local.familyalbum.test/local.familyalbum.test.NativeClientInstrumentation']
if phase=="invite-warm-preview":args[7:7]=["-e","invitationURL",config["invitationURL"]]
try:
 r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=180)
except subprocess.TimeoutExpired:
 print("NATIVE_REAL_UI_PHASE_FAIL SDK_TIMEOUT; no credentials logged");sys.exit(1)
lines=[l for l in r.stdout.splitlines() if 'NATIVE_REAL_UI_PHASE_' in l or l.startswith('INSTRUMENTATION_CODE:')]
for line in lines:print(line)
if not any('NATIVE_REAL_UI_PHASE_PASS' in l for l in lines):
 print('SDK_NATIVE_UI_FAILED; no credentials logged');sys.exit(1)
