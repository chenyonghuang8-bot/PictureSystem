#ifndef PS_STORAGE_ROOT_V2_H
#define PS_STORAGE_ROOT_V2_H
#include "storage_marker.h"

typedef struct {
  int root_fd,parent_fd,fence_fd,writer_fd,locked,committed;
  struct stat root_stat,fence_stat;
  char path[PATH_MAX],name[NAME_MAX+1];
} sm_init_context;
#ifdef PS_STORAGE_TEST_HOOKS
static const char *sm_init_boundaries[]={"root_mkdir","root_open","root_before_lock","root_lock","root_locked","parent_sync","fence_create","fence_write","fence_fsync","fence_fullsync","fence_root_sync","fence_durable","layout_originals_mkdir","layout_originals_sync","layout_originals_parent_sync","layout_originals_durable","layout_uploads_mkdir","layout_uploads_sync","layout_uploads_parent_sync","layout_uploads_durable","layout_temp_mkdir","layout_temp_sync","layout_temp_parent_sync","layout_temp_durable","layout_coord_mkdir","layout_coord_sync","layout_coord_parent_sync","layout_coord_durable","layout_v1_mkdir","layout_v1_sync","layout_v1_parent_sync","layout_v1_durable","marker_create","marker_write","marker_complete_pre_fsync","marker_fsync","marker_after_fsync","marker_fullsync","marker_after_fullsync","marker_root_sync","marker_after_root_sync","marker_close","writer_create","writer_lock","writer_fsync","writer_fullsync","writer_root_sync","writer_complete","layout_validation_sync","probe_create","probe_fsync","probe_close","probe_unlink","probe_root_sync","probe_complete","object_prepare","final_validation","fence_close","final_root_sync","pre_unlink","fence_unlink","unlink_response_error","unlink_query_error","post_unlink","post_unlock"};
static char sm_init_test_boundary[64];
static int sm_init_test_action=0,sm_init_notify=-1,sm_init_control=-1;
#endif
static int sm_init_boundary(const char *name) {
#ifdef PS_STORAGE_TEST_HOOKS
  if(!strcmp(name,sm_init_test_boundary)) {
    sm_init_test_boundary[0]=0;
    if(sm_init_test_action==2) {
      char message[80];int count=snprintf(message,sizeof(message),"%s\n",name);
      char action=0;
      if(count<=0||write_all(sm_init_notify,(unsigned char*)message,(size_t)count))return -1;
      ssize_t n;do{n=read(sm_init_control,&action,1);}while(n<0&&errno==EINTR);
      if(n!=1||action!='C'){errno=EIO;return -1;}
    } else {errno=EIO;return -1;}
  }
#else
  (void)name;
#endif
  return 0;
}
#define SM_INIT(name,call) (sm_init_boundary(name)||(call))
static void sm_init_abort(sm_init_context *ctx) {
  // Abort only releases descriptors. Never undo publication or repair a root.
  if(ctx->fence_fd>=0)close(ctx->fence_fd);
  if(ctx->locked&&ctx->root_fd>=0)(void)flock(ctx->root_fd,LOCK_UN);
  if(ctx->root_fd>=0)close(ctx->root_fd);
  if(ctx->parent_fd>=0)close(ctx->parent_fd);
  ctx->root_fd=ctx->parent_fd=ctx->fence_fd=-1;ctx->locked=0;
}
static int sm_init_fence_identity(sm_init_context *ctx) {
  struct stat named,opened;
  if(!ctx->locked||ctx->committed||ctx->root_fd<0)return -1;
  if(fstatat(ctx->root_fd,".storage-root.initializing",&named,AT_SYMLINK_NOFOLLOW)||
    !sm_same_file(&named,&ctx->fence_stat))return -1;
  if(ctx->fence_fd>=0&&(fstat(ctx->fence_fd,&opened)||!sm_same_file(&opened,&ctx->fence_stat)||sm_no_acl(ctx->fence_fd)))return -1;
  return 0;
}
static int sm_init_directory(sm_init_context *ctx,int parent,const char *name,const char *label) {
  char boundary[64];snprintf(boundary,sizeof(boundary),"layout_%s_mkdir",label);
  if(SM_INIT(boundary,mkdirat(parent,name,0700)))return -1;
  int fd=openat(parent,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);struct stat st;
  if(fd<0)return -1;
  int bad=sm_dir_private(fd,&st)||st.st_dev!=ctx->root_stat.st_dev;
  snprintf(boundary,sizeof(boundary),"layout_%s_sync",label);
  if(!bad)bad=SM_INIT(boundary,sync_directory_fd(fd));
  snprintf(boundary,sizeof(boundary),"layout_%s_parent_sync",label);
  if(!bad)bad=SM_INIT(boundary,sync_directory_fd(parent));
  snprintf(boundary,sizeof(boundary),"layout_%s_durable",label);
  if(!bad)bad=sm_init_boundary(boundary);
  if(bad){int saved=errno;close(fd);errno=saved;return -1;}return fd;
}
static int sm_init_validate(sm_init_context *ctx,sm_marker *binding) {
  struct stat named,held,writer;sm_marker current;
  if(sm_init_fence_identity(ctx)||fstat(ctx->root_fd,&held)||
    held.st_dev!=ctx->root_stat.st_dev||held.st_ino!=ctx->root_stat.st_ino||
    fstatat(ctx->parent_fd,ctx->name,&named,AT_SYMLINK_NOFOLLOW)||
    named.st_dev!=held.st_dev||named.st_ino!=held.st_ino||sm_read_contents(ctx->root_fd,&current))return -1;
  if(ctx->writer_fd>=0&&(fstat(ctx->writer_fd,&writer)||!S_ISREG(writer.st_mode)||
    writer.st_uid!=geteuid()||writer.st_gid!=getegid()||writer.st_dev!=held.st_dev||
    writer.st_nlink!=1||(writer.st_mode&07777)!=0600||sm_no_acl(ctx->writer_fd)||
    fstatat(ctx->root_fd,".writer.lock",&named,AT_SYMLINK_NOFOLLOW)||!sm_same_file(&writer,&named)))return -1;
  int checked=sm_validate_namespace_contents(ctx->root_fd,ctx->path,binding,&current,-1);
  if(checked<0)return -1;close(checked);return 0;
}
// Context exists only after native exclusive final-root mkdir; no runtime
// branch can obtain raw validation permission or clear an initializing fence.
static int sm_init_prepare(const char *path,sm_init_context *ctx,sm_marker *binding) {
  *ctx=(sm_init_context){.root_fd=-1,.parent_fd=-1,.fence_fd=-1,.writer_fd=-1};
  char parent_path[PATH_MAX];int coord=-1,v1=-1,marker=-1;
  if(strlen(path)>=sizeof(parent_path)){errno=EINVAL;return -1;}
  strcpy(ctx->path,path);strcpy(parent_path,path);char *last=strrchr(parent_path,'/');
  if(!last||!last[1]||validate_path_component(last+1)){errno=EINVAL;return -1;}
  strcpy(ctx->name,last+1);if(last==parent_path)last[1]=0;else *last=0;
  ctx->parent_fd=sm_open_path(parent_path);if(ctx->parent_fd<0)return -1;
  if(SM_INIT("root_mkdir",mkdirat(ctx->parent_fd,ctx->name,0700)))goto fail;
  if(sm_init_boundary("root_open"))goto fail;
  ctx->root_fd=openat(ctx->parent_fd,ctx->name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  struct stat named,coord_st,v1_st;
  if(ctx->root_fd<0||sm_dir_private(ctx->root_fd,&ctx->root_stat)||
    fstatat(ctx->parent_fd,ctx->name,&named,AT_SYMLINK_NOFOLLOW)||
    named.st_dev!=ctx->root_stat.st_dev||named.st_ino!=ctx->root_stat.st_ino||sm_init_boundary("root_before_lock"))goto fail;
  if(SM_INIT("root_lock",flock(ctx->root_fd,LOCK_EX|LOCK_NB)))goto fail;ctx->locked=1;
  if(sm_init_boundary("root_locked")||SM_INIT("parent_sync",sync_directory_fd(ctx->parent_fd)))goto fail;
  if(sm_init_boundary("fence_create"))goto fail;
  ctx->fence_fd=openat(ctx->root_fd,".storage-root.initializing",O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  if(ctx->fence_fd<0)goto fail;
  struct stat fence_named;
  if(fstat(ctx->fence_fd,&ctx->fence_stat)||!S_ISREG(ctx->fence_stat.st_mode)||
    ctx->fence_stat.st_uid!=geteuid()||ctx->fence_stat.st_gid!=getegid()||
    ctx->fence_stat.st_dev!=ctx->root_stat.st_dev||ctx->fence_stat.st_nlink!=1||
    (ctx->fence_stat.st_mode&07777)!=0600||sm_no_acl(ctx->fence_fd)||
    fstatat(ctx->root_fd,".storage-root.initializing",&fence_named,AT_SYMLINK_NOFOLLOW)||
    !sm_same_file(&fence_named,&ctx->fence_stat))goto fail;
  const unsigned char fence_bytes[]="FAMILY_ALBUM_INIT1\n";
  if(SM_INIT("fence_write",write_all(ctx->fence_fd,fence_bytes,sizeof(fence_bytes)-1))||
    SM_INIT("fence_fsync",fsync(ctx->fence_fd))||SM_INIT("fence_fullsync",fcntl(ctx->fence_fd,F_FULLFSYNC,0))||
    SM_INIT("fence_root_sync",sync_directory_fd(ctx->root_fd))||fstat(ctx->fence_fd,&ctx->fence_stat)||
    sm_init_fence_identity(ctx)||sm_init_boundary("fence_durable"))goto fail;
  const char *layouts[]={"originals","uploads","temp"};
  for(size_t i=0;i<3;i++){int fd=sm_init_directory(ctx,ctx->root_fd,layouts[i],layouts[i]);if(fd<0)goto fail;close(fd);}
  coord=sm_init_directory(ctx,ctx->root_fd,".coord","coord");if(coord<0)goto fail;
  v1=sm_init_directory(ctx,coord,"v1","v1");if(v1<0)goto fail;
  if(sm_dir_private(coord,&coord_st)||sm_dir_private(v1,&v1_st)||
    coord_st.st_dev!=ctx->root_stat.st_dev||v1_st.st_dev!=ctx->root_stat.st_dev||
    ctx->root_stat.st_dev<=0||!ctx->root_stat.st_ino||coord_st.st_birthtimespec.tv_sec<0||v1_st.st_birthtimespec.tv_sec<0)goto fail;
  char id[33];unsigned char random[16];arc4random_buf(random,sizeof(random));
  for(size_t i=0;i<16;i++)snprintf(id+i*2,3,"%02x",random[i]);
  char bytes[SM_LIMIT];
  int n=snprintf(bytes,sizeof(bytes),"FAMILY_ALBUM_STORAGE_V2:%s:%llu:%llu:%llu:%llu:%llu:%llu:%llu:%llu:%llu:%llu:INIT1\n",id,
    (unsigned long long)ctx->root_stat.st_dev,(unsigned long long)ctx->root_stat.st_ino,
    (unsigned long long)coord_st.st_dev,(unsigned long long)coord_st.st_ino,
    (unsigned long long)coord_st.st_birthtimespec.tv_sec,(unsigned long long)coord_st.st_birthtimespec.tv_nsec,
    (unsigned long long)v1_st.st_dev,(unsigned long long)v1_st.st_ino,
    (unsigned long long)v1_st.st_birthtimespec.tv_sec,(unsigned long long)v1_st.st_birthtimespec.tv_nsec);
  if(n<=0||(size_t)n>=sizeof(bytes)||sm_parse(bytes,(size_t)n,binding)||sm_init_boundary("marker_create"))goto fail;
  marker=openat(ctx->root_fd,".storage-root",O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  if(marker<0||SM_INIT("marker_write",write_all(marker,(unsigned char*)bytes,(size_t)n))||
    sm_init_boundary("marker_complete_pre_fsync")||SM_INIT("marker_fsync",fsync(marker))||
    sm_init_boundary("marker_after_fsync")||SM_INIT("marker_fullsync",fcntl(marker,F_FULLFSYNC,0))||
    sm_init_boundary("marker_after_fullsync")||SM_INIT("marker_root_sync",sync_directory_fd(ctx->root_fd))||
    sm_init_boundary("marker_after_root_sync"))goto fail;
  {int closed=close(marker);marker=-1;if(closed||sm_init_boundary("marker_close"))goto fail;}
  if(sm_read_contents(ctx->root_fd,binding)||sm_init_validate(ctx,binding))goto fail;
  close(v1);close(coord);return 0;
fail:
  {int saved=errno?errno:EPERM;if(marker>=0)close(marker);if(v1>=0)close(v1);if(coord>=0)close(coord);
    sm_init_abort(ctx);errno=saved;return -1;}
}
static int sm_init_commit(sm_init_context *ctx,sm_marker *binding) {
  if(sm_init_boundary("final_validation")||sm_init_validate(ctx,binding))return -1;
  int closed=close(ctx->fence_fd);ctx->fence_fd=-1;
  if(closed||sm_init_boundary("fence_close")||SM_INIT("final_root_sync",sync_directory_fd(ctx->root_fd))||
    sm_init_validate(ctx,binding)||sm_init_boundary("pre_unlink"))return -1;
  int result=SM_INIT("fence_unlink",unlinkat(ctx->root_fd,".storage-root.initializing",0));
  if(!result&&sm_init_boundary("unlink_response_error")){result=-1;errno=EIO;}
#ifdef PS_STORAGE_TEST_HOOKS
  if(!result&&!strcmp(sm_init_test_boundary,"unlink_query_error")){result=-1;errno=EIO;}
#endif
  if(result) {
    int saved=errno;struct stat fence;
    // Only classify the outcome. Never replay unlink or write a rollback.
    if(sm_init_boundary("unlink_query_error")||fstatat(ctx->root_fd,".storage-root.initializing",&fence,AT_SYMLINK_NOFOLLOW)) {
      if(errno==ENOENT)ctx->committed=1;errno=EIO;return -2;
    }
    errno=saved;return -1;
  }
  ctx->committed=1;
  if(sm_init_boundary("post_unlink"))return -2;
  int unlock=flock(ctx->root_fd,LOCK_UN);ctx->locked=0;
  if(unlock||sm_init_boundary("post_unlock"))return -2;
  if(ctx->parent_fd>=0){close(ctx->parent_fd);ctx->parent_fd=-1;}
  return 0;
}
#ifdef PS_STORAGE_TEST_HOOKS
static napi_value sm_test_parse(napi_env env,napi_callback_info info) {
  napi_value arg;size_t argc=1;void *bytes=NULL;size_t length=0;napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  if(argc!=1||napi_get_buffer_info(env,arg,&bytes,&length)!=napi_ok){throw_code(env,"TEST_MARKER_ARGUMENT","Buffer required.");return NULL;}
  sm_marker marker;napi_value out;napi_get_boolean(env,sm_parse(bytes,length,&marker)==0,&out);return out;
}
// Exact old V1 parser format checks, kept test-only so V2 compatibility does
// not depend on a developer's ignored pre-rebuild addon backup.
static napi_value sm_test_legacy_parse(napi_env env,napi_callback_info info) {
  napi_value arg;size_t argc=1;void *raw=NULL;size_t length=0;
  napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  if(argc!=1||napi_get_buffer_info(env,arg,&raw,&length)!=napi_ok){throw_code(env,"TEST_MARKER_ARGUMENT","Buffer required.");return NULL;}
  const char *bytes=raw,*prefix="FAMILY_ALBUM_STORAGE_V1:";size_t prefix_length=strlen(prefix);
  int valid=length==prefix_length+33&&memcmp(bytes,prefix,prefix_length)==0&&bytes[prefix_length+32]=='\n';
  if(valid)for(size_t i=0;i<32;i++){char c=bytes[prefix_length+i];if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))valid=0;}
  napi_value out;napi_get_boolean(env,valid,&out);return out;
}
static int sm_test_values(napi_env env,napi_value array,uint64_t values[4],uint32_t length) {
  uint32_t count=0;if(napi_get_array_length(env,array,&count)!=napi_ok||count!=length)return -1;
  for(uint32_t i=0;i<count;i++){napi_value v;bool lossless=false;if(napi_get_element(env,array,i,&v)!=napi_ok||
    napi_get_value_bigint_uint64(env,v,&values[i],&lossless)!=napi_ok||!lossless)return -1;}return 0;
}
static napi_value sm_test_binding(napi_env env,napi_callback_info info) {
  napi_value args[2];size_t argc=2;uint64_t expected[4],actual[4];napi_get_cb_info(env,info,&argc,args,NULL,NULL);
  if(argc!=2||sm_test_values(env,args[0],expected,4)||sm_test_values(env,args[1],actual,4)) {throw_code(env,"TEST_BINDING_ARGUMENT","Exact identities required.");return NULL;}
  struct stat st={0};st.st_dev=(dev_t)actual[0];st.st_ino=(ino_t)actual[1];
  st.st_birthtimespec.tv_sec=(time_t)actual[2];st.st_birthtimespec.tv_nsec=(long)actual[3];
  napi_value out;napi_get_boolean(env,sm_dir_binding(&st,expected),&out);return out;
}
static napi_value sm_test_properties(napi_env env,napi_callback_info info) {
  napi_value arg;size_t argc=1;uint64_t values[4];napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  if(argc!=1||sm_test_values(env,arg,values,3)){throw_code(env,"TEST_STAT_ARGUMENT","Directory stat required.");return NULL;}
  struct stat st={0};st.st_uid=(uid_t)values[0];st.st_gid=(gid_t)values[1];st.st_mode=(mode_t)values[2];
  napi_value out;napi_get_boolean(env,sm_dir_properties(&st),&out);return out;
}
static napi_value sm_test_init_boundaries(napi_env env,napi_callback_info info) {
  (void)info;napi_value out;napi_create_array(env,&out);
  for(size_t i=0;i<sizeof(sm_init_boundaries)/sizeof(sm_init_boundaries[0]);i++){napi_value name;napi_create_string_utf8(env,sm_init_boundaries[i],NAPI_AUTO_LENGTH,&name);napi_set_element(env,out,(uint32_t)i,name);}return out;
}
static napi_value sm_test_init_boundary(napi_env env,napi_callback_info info) {
  napi_value args[4];size_t argc=4;char name[64],action[16];int32_t notify=-1,control=-1;
  napi_get_cb_info(env,info,&argc,args,NULL,NULL);
  if(argc!=4||get_string(env,args[0],name,sizeof(name))||get_string(env,args[1],action,sizeof(action))||
    napi_get_value_int32(env,args[2],&notify)!=napi_ok||napi_get_value_int32(env,args[3],&control)!=napi_ok){throw_code(env,"TEST_INIT_ARGUMENT","Named boundary and owned pipe required.");return NULL;}
  int known=0;for(size_t i=0;i<sizeof(sm_init_boundaries)/sizeof(sm_init_boundaries[0]);i++)if(!strcmp(name,sm_init_boundaries[i]))known=1;
  if(!known||(strcmp(action,"pause")&&strcmp(action,"error"))||(!strcmp(action,"pause")&&(notify<0||control<0))){throw_code(env,"TEST_INIT_ARGUMENT","Invalid initialization hook.");return NULL;}
  strcpy(sm_init_test_boundary,name);sm_init_test_action=!strcmp(action,"pause")?2:1;sm_init_notify=notify;sm_init_control=control;return undefined_value(env);
}
static napi_value sm_test_fence_error(napi_env env,napi_callback_info info) {
  napi_value arg;size_t argc=1;bool enabled=false;napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  if(argc!=1||napi_get_value_bool(env,arg,&enabled)!=napi_ok)return NULL;sm_test_fence_stat_error=enabled;return undefined_value(env);
}
static napi_value sm_test_root_lock(napi_env env,napi_callback_info info) {
  napi_value args[2];size_t argc=2;char path[PATH_MAX],mode[2];napi_get_cb_info(env,info,&argc,args,NULL,NULL);
  if(argc!=2||get_string(env,args[0],path,sizeof(path))||get_string(env,args[1],mode,sizeof(mode)))return NULL;
  int fd=sm_open_path(path);if(fd<0)return NULL;
  if(flock(fd,(!strcmp(mode,"X")?LOCK_EX:LOCK_SH)|LOCK_NB)){close(fd);napi_value no;napi_get_boolean(env,false,&no);return no;}
  napi_value value;napi_create_int32(env,fd,&value);return value;
}
SM_FN int sm_parse_pre_init1(const char *bytes, size_t length, sm_marker *out) {
  const char *v1="FAMILY_ALBUM_STORAGE_V1:", *v2="FAMILY_ALBUM_STORAGE_V2:";
  const size_t prefix=24;
  if(length<57 || length>SM_LIMIT || memchr(bytes,0,length) || bytes[length-1]!='\n')return -1;
  memset(out,0,sizeof(*out));
  if(!memcmp(bytes,v1,prefix))out->version=1;
  else if(!memcmp(bytes,v2,prefix))out->version=2;
  else return -1;
  for(size_t i=0;i<32;i++) {
    char c=bytes[prefix+i];
    if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return -1;
    out->id[i]=c;
  }
  size_t at=prefix+32;
  if(out->version==1) {if(length!=at+1)return -1;}
  else {
    for(size_t i=0;i<10;i++) {
      if(at>=length || bytes[at++]!=':')return -1;
      size_t start=at; uint64_t value=0;
      while(at<length && bytes[at]>='0' && bytes[at]<='9') {
        unsigned digit=(unsigned)(bytes[at++]-'0');
        if(value>(UINT64_MAX-digit)/10)return -1;
        value=value*10+digit;
      }
      if(at==start || (at-start>1 && bytes[start]=='0'))return -1;
      if((i==0||i==1||i==2||i==3||i==6||i==7)&&value==0)return -1;
      if((i==4||i==8)&&value>INT64_MAX)return -1;
      if((i==5||i==9)&&value>999999999)return -1;
      out->fields[i]=value;
    }
    if(at!=length-1)return -1;
  }
  memcpy(out->bytes,bytes,length);out->length=length;
  return 0;
}

static napi_value sm_test_pre_init1_parse(napi_env env,napi_callback_info info) {
  napi_value arg;size_t argc=1;void *bytes=NULL;size_t length=0;napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  if(argc!=1||napi_get_buffer_info(env,arg,&bytes,&length)!=napi_ok)return NULL;
  sm_marker marker;napi_value out;napi_get_boolean(env,sm_parse_pre_init1(bytes,length,&marker)==0,&out);return out;
}
#endif
#endif
