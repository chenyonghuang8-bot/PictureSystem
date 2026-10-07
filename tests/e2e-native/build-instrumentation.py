"""Build a test-only SDK UIAutomation APK with the existing public debug keystore."""
import pathlib,subprocess,zipfile
root=pathlib.Path(__file__).resolve().parents[2]
sdk=pathlib.Path('/Users/toby/Library/Android/sdk');java=root/'.cache/phase10-jdk/jdk-17.0.20.1+1/Contents/Home/bin';out=root/'.cache/phase10-native-tests';out.mkdir(parents=True,exist_ok=True);(out/'classes').mkdir(exist_ok=True)
manifest=out/'AndroidManifest.xml';manifest.write_text('<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="local.familyalbum.test"><uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36"/><application android:label="PictureSystem DEV UI Tests" android:hasCode="true"/><instrumentation android:name="local.familyalbum.test.NativeClientInstrumentation" android:targetPackage="local.familyalbum.app.dev" android:functionalTest="true"/></manifest>')
bt=sdk/'build-tools/36.0.0';android=sdk/'platforms/android-36/android.jar'
commands=[[str(java/'javac'),'-source','8','-target','8','-cp',str(android),'-d',str(out/'classes'),str(root/'tests/e2e-native/NativeClientInstrumentation.java')],[str(java/'java'),'-cp',str(bt/'lib/d8.jar'),'com.android.tools.r8.D8','--min-api','24','--output',str(out),str(out/'classes/local/familyalbum/test/NativeClientInstrumentation.class')],[str(bt/'aapt2'),'link','-I',str(android),'--manifest',str(manifest),'-o',str(out/'unsigned.apk')]]
for cmd in commands:subprocess.run(cmd,check=True,capture_output=True)
with zipfile.ZipFile(out/'unsigned.apk','a') as z:z.write(out/'classes.dex','classes.dex')
subprocess.run([str(java/'java'),'-jar',str(bt/'lib/apksigner.jar'),'sign','--ks',str(root/'apps/mobile/android/app/debug.keystore'),'--ks-pass','pass:android','--out',str(out/'test.apk'),str(out/'unsigned.apk')],check=True,capture_output=True)
print('SDK_INSTRUMENTATION_TEST_APK_BUILT; existing public debug key only')
