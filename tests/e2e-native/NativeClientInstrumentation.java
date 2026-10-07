package local.familyalbum.test;

import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.KeyEvent;
import java.io.File;
import java.io.FileOutputStream;

/** SDK UIAutomation against actual RN/System picker UI; no mocked app methods. */
public final class NativeClientInstrumentation extends Instrumentation {
  private Bundle args;
  @Override public void onCreate(Bundle args) { super.onCreate(args); this.args=args; start(); }
  private AccessibilityNodeInfo find(AccessibilityNodeInfo n,String value,boolean contains) {
    if(n==null)return null;
    String text=n.getText()==null?"":n.getText().toString();
    String desc=n.getContentDescription()==null?"":n.getContentDescription().toString();
    if(contains ? text.contains(value)||desc.contains(value) : text.equals(value)||desc.equals(value))return n;
    for(int i=0;i<n.getChildCount();i++){AccessibilityNodeInfo hit=find(n.getChild(i),value,contains);if(hit!=null)return hit;}
    return null;
  }
  private AccessibilityNodeInfo scrollable(AccessibilityNodeInfo n) {
    if(n==null)return null;if(n.isScrollable())return n;for(int i=0;i<n.getChildCount();i++){AccessibilityNodeInfo hit=scrollable(n.getChild(i));if(hit!=null)return hit;}return null;
  }
  private AccessibilityNodeInfo waitNode(String value,boolean contains,long timeout) {
    long end=SystemClock.elapsedRealtime()+timeout;
    do {AccessibilityNodeInfo n=find(getUiAutomation().getRootInActiveWindow(),value,contains);if(n!=null)return n;if(value.equals("上传队列")||value.equals("已加入相册")||value.startsWith("上传任务 ")){AccessibilityNodeInfo scroll=scrollable(getUiAutomation().getRootInActiveWindow());if(scroll!=null)scroll.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);}SystemClock.sleep(150);}while(SystemClock.elapsedRealtime()<end);
    throw new IllegalStateException("UI_NOT_FOUND: "+value);
  }
  private AccessibilityNodeInfo clickable(AccessibilityNodeInfo n,String value,boolean contains) {
    if(n==null)return null;
    String t=n.getText()==null?"":n.getText().toString(), d=n.getContentDescription()==null?"":n.getContentDescription().toString();
    if(contains?t.contains(value)||d.contains(value):t.equals(value)||d.equals(value)) {
      AccessibilityNodeInfo p=n;
      while(p!=null){if(p.isClickable()&&p.isEnabled())return p;p=p.getParent();}
    }
    for(int i=0;i<n.getChildCount();i++){AccessibilityNodeInfo hit=clickable(n.getChild(i),value,contains);if(hit!=null)return hit;}
    return null;
  }
  private void click(String value,boolean contains) {
    long end=SystemClock.elapsedRealtime()+30000;
    do{AccessibilityNodeInfo n=clickable(getUiAutomation().getRootInActiveWindow(),value,contains);if(n!=null&&n.performAction(AccessibilityNodeInfo.ACTION_CLICK)){SystemClock.sleep(250);return;}SystemClock.sleep(150);}while(SystemClock.elapsedRealtime()<end);
    throw new IllegalStateException("UI_NOT_CLICKABLE: "+value);
  }
  private void input(String label,String value) {
    AccessibilityNodeInfo n=waitNode(label,false,30000);Bundle b=new Bundle();b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,value);
    if(!n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,b))throw new IllegalStateException("INPUT_FAILED: "+label);
    SystemClock.sleep(200);
  }
  private void screenshot(String name) throws Exception {
    File file=new File(getTargetContext().getFilesDir(),"phase10-"+name+".png");
    try(FileOutputStream out=new FileOutputStream(file)){Bitmap image=getUiAutomation().takeScreenshot();if(image==null||!image.compress(Bitmap.CompressFormat.PNG,100,out))throw new IllegalStateException("SCREENSHOT_FAILED");}
  }
  private void startApp(){Intent i=new Intent();i.setClassName("local.familyalbum.app.dev","local.familyalbum.app.MainActivity");i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);getTargetContext().startActivity(i);}
  @Override public void onStart() {
    Bundle result=new Bundle();
    try {
      startApp();String phase=args.getString("phase");
      if(phase.startsWith("okhttp-probe")) {
        Class<?> provider=Class.forName("com.facebook.react.modules.network.OkHttpClientProvider"), requestClass=Class.forName("okhttp3.Request"), builderClass=Class.forName("okhttp3.Request$Builder");
        Object client=provider.getMethod("createClient",android.content.Context.class).invoke(null,getTargetContext());
        Object builder=builderClass.getConstructor().newInstance();builderClass.getMethod("url",String.class).invoke(builder,"https://10.0.2.2:"+("okhttp-probe-isolated".equals(phase)?"3445":"3443")+"/api/v1/auth/me");
        Object request=builderClass.getMethod("build").invoke(builder);
        Object call=Class.forName("okhttp3.OkHttpClient").getMethod("newCall",requestClass).invoke(client,request);
        Object response=Class.forName("okhttp3.Call").getMethod("execute").invoke(call);
        int status=(Integer)Class.forName("okhttp3.Response").getMethod("code").invoke(response);Class.forName("okhttp3.Response").getMethod("close").invoke(response);
        if(status!=401)throw new IllegalStateException("OKHTTP_STRICT_STATUS_"+status);
      } else if("transport-probe".equals(phase)||"transport-login-probe".equals(phase)) {
        javax.net.ssl.HttpsURLConnection connection=(javax.net.ssl.HttpsURLConnection)new java.net.URL("https://10.0.2.2:3443/api/v1/auth/"+(phase.equals("transport-probe")?"me":"android/login")).openConnection();
        connection.setConnectTimeout(15000);connection.setReadTimeout(15000);connection.setInstanceFollowRedirects(false);
        if(phase.equals("transport-login-probe")){
          connection.setRequestMethod("POST");connection.setRequestProperty("Content-Type","application/json");connection.setDoOutput(true);
          org.json.JSONObject body=new org.json.JSONObject();body.put("username",args.getString("username"));body.put("password",args.getString("password"));body.put("deviceLabel","SDK synthetic diagnostic");
          try(java.io.OutputStream out=connection.getOutputStream()){out.write(body.toString().getBytes("UTF-8"));}
        }
        int status=connection.getResponseCode();connection.disconnect();if(status!=(phase.equals("transport-probe")?401:200))throw new IllegalStateException("STRICT_NATIVE_TLS_STATUS_"+status);
      } else if("login-upload".equals(phase)||"pick-upload".equals(phase)||"partial-upload".equals(phase)){
        if("login-upload".equals(phase)||"partial-upload".equals(phase)){
        long authUntil=SystemClock.elapsedRealtime()+60000;
        while(find(getUiAutomation().getRootInActiveWindow(),args.getString("family"),false)==null&&find(getUiAutomation().getRootInActiveWindow(),"账号",false)==null&&SystemClock.elapsedRealtime()<authUntil)SystemClock.sleep(100);
        SystemClock.sleep(1500);
        if(find(getUiAutomation().getRootInActiveWindow(),args.getString("family"),false)==null){
          try{input("账号",args.getString("username"));input("密码",args.getString("password"));click("登录",false);}
          catch(IllegalStateException e){if(find(getUiAutomation().getRootInActiveWindow(),args.getString("family"),false)==null)throw e;}
        }
        waitNode(args.getString("family"),false,30000);}
        waitNode(args.getString("family"),false,30000);screenshot("authenticated-photos");
        click("相册",false);waitNode("Low",false,30000);screenshot("albums");
        click("回忆",false);waitNode("往年今日",true,30000);screenshot("memories");
        click("我的",false);waitNode("我的家庭",false,30000);screenshot("my");
        click("照片",false);click("选择照片上传",false);waitNode("选择目标相册",false,30000);click("Low",false);click("选择多张照片并上传",false);
        if(find(getUiAutomation().getRootInActiveWindow(),args.getString("file"),true)==null){
          click("Show roots",true);click("Downloads",true);
        }
        screenshot("picker-before-select");
        AccessibilityNodeInfo item=waitNode(args.getString("file"),true,30000);boolean selected=false;
        while(item!=null){if(item.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)){selected=true;break;}item=item.getParent();}
        if(!selected)click(args.getString("file"),true);
        SystemClock.sleep(400);screenshot("picker-after-select");
        AccessibilityNodeInfo open=find(getUiAutomation().getRootInActiveWindow(),"Open",false);if(open!=null)click("Open",false);else click("Select",false);
        SystemClock.sleep(700);click("我的",false);waitNode("上传队列",true,30000);if("partial-upload".equals(phase))SystemClock.sleep(120000);else waitNode("已加入相册",true,120000);screenshot("upload-queue");
      } else if("resume-viewer".equals(phase)){
        waitNode(args.getString("family"),false,30000);click("我的",false);waitNode("上传任务 "+args.getString("file")+"：已加入相册",false,120000);screenshot("ready-queue");
        click("照片",false);click("查看",true);waitNode("关闭照片",false,30000);screenshot("viewer");click("关闭照片",false);
      } else if("logout".equals(phase)){
        waitNode(args.getString("family"),false,30000);click("我的",false);click("退出登录",false);waitNode("登录",false,30000);screenshot("logout");
      } else if("logged-out".equals(phase)){
        waitNode("登录",false,30000);screenshot("cold-logged-out");
      } else if("invite-preview".equals(phase)||"invite-warm-preview".equals(phase)){
        waitNode(args.getString("family"),false,30000);
        if("invite-warm-preview".equals(phase)){Intent link=new Intent(Intent.ACTION_VIEW,android.net.Uri.parse(args.getString("invitationURL")));link.setPackage("local.familyalbum.app.dev");link.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);getTargetContext().startActivity(link);SystemClock.sleep(500);waitNode(args.getString("family"),false,30000);}
        waitNode("确认创建新账号并加入家庭",false,30000);screenshot("invite-preview");
      } else if("invite-consume".equals(phase)){
        waitNode("确认创建新账号并加入家庭",false,30000);input("账号",args.getString("username"));input("密码",args.getString("password"));click("确认创建新账号并加入家庭",false);click("确认",false);waitNode("账号已创建，请正常登录",false,30000);waitNode("登录",false,30000);screenshot("invite-created-not-auto-login");
      } else throw new IllegalStateException("UNKNOWN_PHASE");
      result.putString("stream","NATIVE_REAL_UI_PHASE_PASS "+phase+"\n");finish(0,result);
    } catch(Exception e){
      if(e instanceof java.lang.reflect.InvocationTargetException && e.getCause()!=null) {
        Throwable cause=e.getCause();
        String classes=""; for(int depth=0;cause!=null&&depth<6;depth++,cause=cause.getCause())classes+=cause.getClass().getSimpleName()+"/";
        result.putString("stream","NATIVE_REAL_UI_PHASE_FAIL SDK_TRANSPORT_CLASS_"+classes+"\n");finish(1,result);return;
      }
      try{screenshot("failure");}catch(Exception ignored){}result.putString("stream","NATIVE_REAL_UI_PHASE_FAIL "+e.getMessage()+"\n");finish(1,result);}
  }
}
