#ifndef PS_OPERATION_GATE_H
#define PS_OPERATION_GATE_H
#define PS_OPERATION_MAGIC UINT64_C(0x4f50474154453031)
typedef struct op_owned_bridge { char name[40]; struct op_owned_bridge *next; } op_owned_bridge;
typedef struct {
  uint64_t magic;
  int directory_fd, lock_fd;
  dev_t device;
  ino_t directory_inode, lock_inode;
  char path[PATH_MAX], deployment[37], name[16];
  int held, exclusive, drained;
  op_owned_bridge *bridges;
} ps_operation_gate;

static int op_valid_file(int fd, struct stat *st) {
  return fstat(fd,st)==0 && S_ISREG(st->st_mode) && st->st_uid==geteuid() &&
    (st->st_mode&07777)==0600 && st->st_nlink==1 && validate_no_extended_acl(fd)==0;
}
static int op_valid_directory(int fd, struct stat *st) {
  return validate_directory_fd(fd,st)==0 && st->st_uid==geteuid() && (st->st_mode&07777)==0700;
}
static int op_uuid(const char *s) {
  if(strlen(s)!=36)return 0;
  for(int i=0;i<36;i++) {
    if(i==8||i==13||i==18||i==23) {if(s[i]!='-')return 0;}
    else if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f')))return 0;
  }
  return 1;
}
static int op_identity(int directory,const char *deployment,int provision) {
  int fd=openat(directory,"identity",O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
  if(fd<0 && errno==ENOENT && provision) {
    fd=openat(directory,"identity",O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
    if(fd<0)return -1;
    char value[96];int length=snprintf(value,sizeof(value),"PS_CONTROL_V1\nfamily_album_dev\n%s\n",deployment);
    int ok=write(fd,value,(size_t)length)==length && full_sync_file_fd(fd)==0;
    close(fd);
    if(!ok || sync_directory_fd(directory)!=0)return -1;
    fd=openat(directory,"identity",O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
  }
  if(fd<0)return -1;
  struct stat st;char value[96],expected[96];
  int length=snprintf(expected,sizeof(expected),"PS_CONTROL_V1\nfamily_album_dev\n%s\n",deployment);
  int valid=op_valid_file(fd,&st)&&st.st_size==length;
  ssize_t n=valid?read(fd,value,sizeof(value)):-1;
  close(fd);return valid&&n==length&&memcmp(value,expected,(size_t)length)==0?0:-1;
}
static int op_validate(ps_operation_gate *g) {
  struct stat d,l,named;
  int fresh=open_absolute_directory(g->path,0);
  int valid=fresh>=0&&op_valid_directory(g->directory_fd,&d)&&
    fstat(fresh,&named)==0&&named.st_dev==g->device&&named.st_ino==g->directory_inode&&
    d.st_dev==g->device&&d.st_ino==g->directory_inode&&op_valid_file(g->lock_fd,&l)&&
    l.st_dev==g->device&&l.st_ino==g->lock_inode&&
    fstatat(g->directory_fd,g->name,&named,AT_SYMLINK_NOFOLLOW)==0&&
    named.st_dev==l.st_dev&&named.st_ino==l.st_ino&&op_identity(g->directory_fd,g->deployment,0)==0;
  if(fresh>=0)close(fresh);
  return valid?0:-1;
}
#include "operation_bridge.h"
static void op_finalize(napi_env env,void *data,void *hint) {
  (void)env;(void)hint;ps_operation_gate *g=data;if(!g)return;
  // Close releases this process's reference. Never explicitly LOCK_UN a
  // descriptor that a registered child may still hold.
  if(g->lock_fd>=0)close(g->lock_fd);
  if(g->directory_fd>=0)close(g->directory_fd);
  while(g->bridges){op_owned_bridge *n=g->bridges;g->bridges=n->next;free(n);}
  g->magic=0;free(g);
}
static ps_operation_gate *op_get(napi_env env,napi_value value) {
  ps_operation_gate *g=NULL;
  if(napi_get_value_external(env,value,(void**)&g)!=napi_ok||!g||g->magic!=PS_OPERATION_MAGIC||g->lock_fd<0) {
    throw_code(env,"OPERATION_GATE_CLOSED","Control gate is closed.");return NULL;
  }
  return g;
}
static napi_value op_open(napi_env env,napi_callback_info info) {
  napi_value a[4];size_t count=4;napi_get_cb_info(env,info,&count,a,NULL,NULL);
  char path[PATH_MAX],deployment[37],kind[2];bool provision=false;
  if(count!=4||get_string(env,a[0],path,sizeof(path))||get_string(env,a[1],deployment,sizeof(deployment))||
    get_string(env,a[2],kind,sizeof(kind))||napi_get_value_bool(env,a[3],&provision)!=napi_ok||
    !op_uuid(deployment)||!(kind[0]=='G'||kind[0]=='L'||kind[0]=='R')) {
    throw_code(env,"OPERATION_GATE_INVALID","Invalid control configuration.");return NULL;
  }
  int directory=open_absolute_directory(path,provision?1:0);struct stat d;
  if(directory<0||!op_valid_directory(directory,&d)||op_identity(directory,deployment,provision)!=0) {
    if(directory>=0)close(directory);
    throw_code(env,"OPERATION_NAMESPACE_INVALID","Control namespace is unavailable.");return NULL;
  }
  const char *name=kind[0]=='G'?"operation.lock":kind[0]=='L'?"latch.lock":"run.lock";
  int fd=openat(directory,name,O_RDWR|O_NOFOLLOW|O_CLOEXEC);
  if(fd<0&&errno==ENOENT&&provision) {
    fd=openat(directory,name,O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
    if(fd>=0&&(full_sync_file_fd(fd)!=0||sync_directory_fd(directory)!=0)) {close(fd);fd=-1;}
  }
  struct stat l;
  if(fd<0||!op_valid_file(fd,&l)) {
    if(fd>=0)close(fd);close(directory);
    throw_code(env,"OPERATION_NAMESPACE_INVALID","Control lock is unavailable.");return NULL;
  }
  ps_operation_gate *g=calloc(1,sizeof(*g));
  if(!g) {close(fd);close(directory);throw_code(env,"OPERATION_GATE_UNAVAILABLE","Control allocation failed.");return NULL;}
  *g=(ps_operation_gate){.magic=PS_OPERATION_MAGIC,.directory_fd=directory,.lock_fd=fd,
    .device=d.st_dev,.directory_inode=d.st_ino,.lock_inode=l.st_ino};
  strcpy(g->path,path);strcpy(g->deployment,deployment);strcpy(g->name,name);
  napi_value value;napi_create_external(env,g,op_finalize,NULL,&value);return value;
}
static napi_value op_try(napi_env env,napi_callback_info info) {
  napi_value a[2];size_t count=2;napi_get_cb_info(env,info,&count,a,NULL,NULL);char mode[2];
  ps_operation_gate *g=count==2?op_get(env,a[0]):NULL;if(!g)return NULL;
  if(get_string(env,a[1],mode,sizeof(mode))||!(mode[0]=='S'||mode[0]=='X')||g->held||
    ((!strcmp(g->name,"latch.lock")||!strcmp(g->name,"run.lock"))&&mode[0]!='X')||op_validate(g)!=0) {
    throw_code(env,"OPERATION_NAMESPACE_INVALID","Control acquisition rejected.");return NULL;
  }
  int rc=flock(g->lock_fd,(mode[0]=='X'?LOCK_EX:LOCK_SH)|LOCK_NB);
  if(rc!=0&&errno!=EWOULDBLOCK&&errno!=EAGAIN) {
    throw_code(env,"OPERATION_GATE_UNAVAILABLE","Control acquisition failed.");return NULL;
  }
  if(rc==0) {
    g->held=1;g->exclusive=mode[0]=='X';
    if(op_validate(g)!=0) {close(g->lock_fd);g->lock_fd=-1;throw_code(env,"OPERATION_NAMESPACE_INVALID","Control identity changed.");return NULL;}
  }
  if(rc==0 && g->exclusive && !strcmp(g->name,"operation.lock")) {
    int drained=op_scan_bridges(g);
    if(drained!=1) {
      /* RAW_X never leaves this function: release the private descriptor. */
      close(g->lock_fd);g->lock_fd=-1;g->held=0;
      close(g->directory_fd);g->directory_fd=-1;
      throw_code(env,drained==0?"OPERATION_CHILDREN_ACTIVE":"OPERATION_BRIDGE_UNKNOWN",
        "Deployment children have not been proven drained.");return NULL;
    }
    g->drained=1;
  }
  napi_value value;napi_get_boolean(env,rc==0,&value);return value;
}
static napi_value op_close(napi_env env,napi_callback_info info) {
  napi_value a;size_t count=1;napi_get_cb_info(env,info,&count,&a,NULL,NULL);
  ps_operation_gate *g=op_get(env,a);if(!g)return NULL;
  int finished=!g->exclusive && g->held?op_finish_owned(g):0;
  int fd=g->lock_fd;g->lock_fd=-1;g->held=0;
  int failure=close(fd);
  int directory=g->directory_fd;g->directory_fd=-1;
  if(directory>=0&&close(directory))failure=-1;
  if(failure){throw_code(env,"OPERATION_GATE_UNAVAILABLE","Control close failed.");return NULL;}
  if(finished){throw_code(env,"OPERATION_BRIDGE_UNKNOWN","Deployment child settlement is unconfirmed.");return NULL;}
  napi_value value;napi_get_undefined(env,&value);return value;
}
static napi_value op_identity_value(napi_env env,napi_callback_info info) {
  napi_value a;size_t count=1;napi_get_cb_info(env,info,&count,&a,NULL,NULL);ps_operation_gate *g=op_get(env,a);
  if(!g)return NULL;if(op_validate(g)!=0){throw_code(env,"OPERATION_NAMESPACE_INVALID","Control identity changed.");return NULL;}
  char material[192],hex[65];unsigned char digest[32];
  int n=snprintf(material,sizeof(material),"%s:%s:%llu:%llu:%llu",strcmp(g->name,"run.lock")==0?"PS_RUN_V1":"PS_CONTROL_V1",g->deployment,
    (unsigned long long)g->device,(unsigned long long)g->directory_inode,(unsigned long long)g->lock_inode);
  CC_SHA256(material,(CC_LONG)n,digest);
  for(int i=0;i<32;i++)snprintf(hex+i*2,3,"%02x",digest[i]);
  napi_value value;napi_create_string_utf8(env,hex,64,&value);return value;
}

/* Coordinator ownership record. No numeric descriptor is ever exported. */
static napi_value op_run_owner(napi_env env,napi_callback_info info) {
  napi_value a[2];size_t count=2;napi_get_cb_info(env,info,&count,a,NULL,NULL);
  ps_operation_gate *g=count==2?op_get(env,a[0]):NULL;if(!g)return NULL;
  char process[37],boot[37],record[180];uint64_t sec=0,usec=0;
  if(!g->held||!g->exclusive||strcmp(g->name,"run.lock")||op_validate(g)||
     get_string(env,a[1],process,sizeof(process))||!op_uuid(process)||ps_boot_uuid(boot)||
     ps_process_identity(getpid(),&sec,&usec)!=1) {
    throw_code(env,"OPERATION_RUN_UNCONFIRMED","Run coordinator identity is unavailable.");return NULL;
  }
  for(int i=0;i<36;i++)if(boot[i]>='A'&&boot[i]<='F')boot[i]=(char)(boot[i]-'A'+'a');
  int n=snprintf(record,sizeof(record),"PS_RUN_OWNER_V1\n%s\n%d:%llu:%llu\n%s\n",boot,getpid(),(unsigned long long)sec,(unsigned long long)usec,process);
  if(pwrite(g->lock_fd,record,(size_t)n,0)!=n||ftruncate(g->lock_fd,n)||full_sync_file_fd(g->lock_fd)||sync_directory_fd(g->directory_fd)) {
    throw_code(env,"OPERATION_RUN_UNCONFIRMED","Run coordinator registration is uncertain.");return NULL;
  }
  napi_value out,value;napi_create_object(env,&out);
  napi_create_string_utf8(env,boot,NAPI_AUTO_LENGTH,&value);napi_set_named_property(env,out,"osBootId",value);
  napi_create_int32(env,getpid(),&value);napi_set_named_property(env,out,"pid",value);
  char decimal[24];snprintf(decimal,sizeof(decimal),"%llu",(unsigned long long)sec);napi_create_string_utf8(env,decimal,NAPI_AUTO_LENGTH,&value);napi_set_named_property(env,out,"startSec",value);
  napi_create_uint32(env,(uint32_t)usec,&value);napi_set_named_property(env,out,"startUsec",value);
  return out;
}
static napi_value op_verify_run_owner(napi_env env,napi_callback_info info) {
  napi_value a[6];size_t count=6;napi_get_cb_info(env,info,&count,a,NULL,NULL);
  ps_operation_gate *g=count==6?op_get(env,a[0]):NULL;if(!g)return NULL;
  char process[37],boot[37],current_boot[37],sec_string[24],actual[180],expected[180];uint32_t pid=0,usec=0;
  if(strcmp(g->name,"run.lock")||g->held||op_validate(g)||get_string(env,a[1],process,sizeof(process))||!op_uuid(process)||
    get_string(env,a[2],boot,sizeof(boot))||!op_uuid(boot)||napi_get_value_uint32(env,a[3],&pid)!=napi_ok||!pid||pid>INT_MAX||
    get_string(env,a[4],sec_string,sizeof(sec_string))||napi_get_value_uint32(env,a[5],&usec)!=napi_ok||usec>=1000000||ps_boot_uuid(current_boot)) {
    throw_code(env,"OPERATION_RUN_UNCONFIRMED","Run coordinator proof is unavailable.");return NULL;
  }
  for(int i=0;i<36;i++)if(current_boot[i]>='A'&&current_boot[i]<='F')current_boot[i]=(char)(current_boot[i]-'A'+'a');
  char *end=NULL;errno=0;unsigned long long sec=strtoull(sec_string,&end,10);
  if(errno||!sec||!end||*end){throw_code(env,"OPERATION_RUN_UNCONFIRMED","Invalid run identity.");return NULL;}
  int n=snprintf(expected,sizeof(expected),"PS_RUN_OWNER_V1\n%s\n%u:%llu:%u\n%s\n",boot,pid,sec,usec,process);
  struct stat st;ssize_t bytes=pread(g->lock_fd,actual,sizeof(actual),0);
  int valid=fstat(g->lock_fd,&st)==0&&bytes==n&&st.st_size==n&&!memcmp(actual,expected,(size_t)n)&&!strcmp(boot,current_boot);
  int lock_result=flock(g->lock_fd,LOCK_SH|LOCK_NB);
  if(lock_result==0){valid=0;if(flock(g->lock_fd,LOCK_UN))valid=0;}
  else if(errno!=EWOULDBLOCK&&errno!=EAGAIN)valid=0;
  if(valid)valid=op_incarnation_live((int)pid,(uint64_t)sec,usec)==1;
  /* Identity can change between the first read and liveness probe. Reject it. */
  if(valid){bytes=pread(g->lock_fd,actual,sizeof(actual),0);valid=fstat(g->lock_fd,&st)==0&&bytes==n&&st.st_size==n&&!memcmp(actual,expected,(size_t)n);}
  if(op_validate(g))valid=0;
  napi_value result;napi_get_boolean(env,valid,&result);return result;
}
static int op_read_deny(ps_operation_gate *g,char token[65],char reason[49]) {
  if(op_validate(g)!=0)return -1;
  int fd=openat(g->directory_fd,"deny",O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
  if(fd<0)return errno==ENOENT?0:-1;
  struct stat st;char bytes[160];
  int valid=op_valid_file(fd,&st)&&st.st_size>0&&st.st_size<(off_t)sizeof(bytes);
  ssize_t n=valid?read(fd,bytes,sizeof(bytes)-1):-1;close(fd);
  if(!valid||n!=st.st_size)return -1;
  bytes[n]='\0';char deployment[37],nonce[33],parsed[49],rebuilt[160];int consumed=0;
  if(sscanf(bytes,"PS_DENY_V1\n%36[0-9a-f-]\n%32[0-9a-f]\n%48[A-Z_]\n%n",deployment,nonce,parsed,&consumed)!=3||
    consumed!=n||strcmp(deployment,g->deployment)||strlen(nonce)!=32||strlen(parsed)<1)return -1;
  int expected=snprintf(rebuilt,sizeof(rebuilt),"PS_DENY_V1\n%s\n%s\n%s\n",deployment,nonce,parsed);
  if(expected!=n||memcmp(bytes,rebuilt,(size_t)n))return -1;
  unsigned char digest[32];CC_SHA256(bytes,(CC_LONG)n,digest);
  for(int i=0;i<32;i++)snprintf(token+i*2,3,"%02x",digest[i]);strcpy(reason,parsed);return 1;
}
static napi_value op_deny_result(napi_env env,int state,const char *token,const char *reason) {
  if(state<0){throw_code(env,"OPERATION_DENY_UNCERTAIN","Durable protection is unavailable.");return NULL;}
  if(state==0){napi_value value;napi_get_null(env,&value);return value;}
  napi_value out,value;napi_create_object(env,&out);
  napi_create_string_utf8(env,token,64,&value);napi_set_named_property(env,out,"token",value);
  napi_create_string_utf8(env,reason,NAPI_AUTO_LENGTH,&value);napi_set_named_property(env,out,"reasonCode",value);return out;
}
static napi_value op_read_marker(napi_env env,napi_callback_info info) {
  napi_value a;size_t count=1;napi_get_cb_info(env,info,&count,&a,NULL,NULL);
  ps_operation_gate *g=op_get(env,a);if(!g)return NULL;
  char token[65]={0},reason[49]={0};int state=op_read_deny(g,token,reason);
  return op_deny_result(env,state,token,reason);
}
/* Fault controls are compiled only into the synthetic qualification addon. */
#ifdef PS_STORAGE_TEST_HOOKS
static char op_test_deny_boundary[32];
static napi_value op_test_deny_fault(napi_env env,napi_callback_info info) {
  napi_value a;size_t count=1;napi_get_cb_info(env,info,&count,&a,NULL,NULL);
  char boundary[32];
  if(count!=1||get_string(env,a,boundary,sizeof(boundary))||
    (strcmp(boundary,"NONE")&&strcmp(boundary,"TEMP_CREATE")&&strcmp(boundary,"FILE_FSYNC")&&strcmp(boundary,"LATCH_DIR_FSYNC")&&strcmp(boundary,"CLEAR_DIR_FSYNC"))) {
    throw_code(env,"TEST_BOUNDARY_INVALID","Unknown synthetic deny boundary.");return NULL;
  }
  strcpy(op_test_deny_boundary,boundary);return undefined_value(env);
}
static int op_deny_boundary(const char *name) {
  if(strcmp(name,op_test_deny_boundary))return 0;
  op_test_deny_boundary[0]='\0';errno=EIO;return -1;
}
#else
#define op_deny_boundary(name) 0
#endif
static napi_value op_latch_marker(napi_env env,napi_callback_info info) {
  napi_value a[2];size_t count=2;napi_get_cb_info(env,info,&count,a,NULL,NULL);
  ps_operation_gate *g=count==2?op_get(env,a[0]):NULL;if(!g)return NULL;
  char reason[49];
  if(!g->held||!g->exclusive||strcmp(g->name,"latch.lock")||get_string(env,a[1],reason,sizeof(reason))||
    reason[0]=='\0'||op_validate(g)!=0){throw_code(env,"OPERATION_LATCH_REQUIRED","Exclusive control latch is required.");return NULL;}
  for(const char *p=reason;*p;p++)if(!((*p>='A'&&*p<='Z')||*p=='_')){
    throw_code(env,"OPERATION_REASON_INVALID","Invalid protection reason.");return NULL;
  }
  char token[65]={0},old_reason[49]={0};int state=op_read_deny(g,token,old_reason);
  if(state!=0)return op_deny_result(env,state,token,old_reason);
  unsigned char random[16];arc4random_buf(random,sizeof(random));char nonce[33];
  for(int i=0;i<16;i++)snprintf(nonce+i*2,3,"%02x",random[i]);
  char temporary[48],content[160];snprintf(temporary,sizeof(temporary),"deny.%s",nonce);
  int length=snprintf(content,sizeof(content),"PS_DENY_V1\n%s\n%s\n%s\n",g->deployment,nonce,reason);
  int fd=op_deny_boundary("TEMP_CREATE")?-1:openat(g->directory_fd,temporary,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  if(fd<0){throw_code(env,"OPERATION_DENY_UNCERTAIN","Durable protection cannot be created.");return NULL;}
  size_t written=0;int ok=1;
  while(written<(size_t)length){ssize_t n=write(fd,content+written,(size_t)length-written);if(n>0)written+=(size_t)n;else if(n<0&&errno==EINTR)continue;else {ok=0;break;}}
  if(ok)ok=op_deny_boundary("FILE_FSYNC")==0&&full_sync_file_fd(fd)==0;
  if(ok)ok=op_validate(g)==0&&renameat(g->directory_fd,temporary,g->directory_fd,"deny")==0&&op_deny_boundary("LATCH_DIR_FSYNC")==0&&sync_directory_fd(g->directory_fd)==0;
  if(!ok){
    /* Only this still-open, exactly named temporary is eligible. Once renamed,
       its old name is absent and the durable deny is never removed here. A
       failed cleanup remains an unknown entry, so bridge drain fails closed. */
    if(op_validate(g)==0&&ps_handoff_named_identity(g->directory_fd,fd,temporary)==0&&
       unlinkat(g->directory_fd,temporary,0)==0)(void)sync_directory_fd(g->directory_fd);
    close(fd);throw_code(env,"OPERATION_DENY_UNCERTAIN","Durable protection cannot be confirmed.");return NULL;
  }
  close(fd);
  state=op_read_deny(g,token,old_reason);return op_deny_result(env,state,token,old_reason);
}
static napi_value op_clear_marker(napi_env env,napi_callback_info info) {
  napi_value a[3];size_t count=3;napi_get_cb_info(env,info,&count,a,NULL,NULL);
  ps_operation_gate *x=count==3?op_get(env,a[0]):NULL;if(!x)return NULL;
  ps_operation_gate *l=op_get(env,a[1]);if(!l)return NULL;char expected[65];
  if(!x->held||!x->exclusive||!x->drained||strcmp(x->name,"operation.lock")||!l->held||!l->exclusive||strcmp(l->name,"latch.lock")||
    x->device!=l->device||x->directory_inode!=l->directory_inode||op_validate(x)||op_validate(l)||
    get_string(env,a[2],expected,sizeof(expected))||strlen(expected)!=64){throw_code(env,"OPERATION_RECOVERY_REQUIRED","Fenced recovery is required.");return NULL;}
  char token[65],reason[49];int state=op_read_deny(l,token,reason);
  if(state!=1||strcmp(token,expected)){throw_code(env,"OPERATION_MARKER_CHANGED","Protection changed during recovery.");return NULL;}
  if(unlinkat(l->directory_fd,"deny",0)||op_deny_boundary("CLEAR_DIR_FSYNC")||sync_directory_fd(l->directory_fd)){
    throw_code(env,"OPERATION_DENY_UNCERTAIN","Protection removal could not be confirmed.");return NULL;
  }
  return undefined_value(env);
}
static napi_value op_recover_bridges(napi_env env,napi_callback_info info) {
  napi_value arg;size_t count=1;napi_get_cb_info(env,info,&count,&arg,NULL,NULL);
  ps_operation_gate *g=count==1?op_get(env,arg):NULL;if(!g)return NULL;
  if(op_recover_bridge_index(g)) {
    g->drained=0;
    throw_code(env,"OPERATION_BRIDGE_UNKNOWN","Drained bridge recovery could not be confirmed.");return NULL;
  }
  return undefined_value(env);
}
#endif
