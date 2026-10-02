#ifndef PS_REGISTERED_CONSUMER_BINDING_H
#define PS_REGISTERED_CONSUMER_BINDING_H
typedef struct {ps_handoff_t *handoff;int control,child;int armed,sent,test_withhold;} p7_launch;
static void p7_launch_finalize(napi_env env,void *data,void *hint) {
  (void)hint;p7_launch *l=data;if(!l)return;
  if(l->control>=0)close(l->control);if(l->child>=0)close(l->child);
  if(l->handoff)ps_handoff_finalize(env,l->handoff,NULL);free(l);
}
static p7_launch *p7_get_launch(napi_env env,napi_value v) {
  p7_launch *l=NULL;if(napi_get_value_external(env,v,(void**)&l)!=napi_ok||!l||!l->handoff||l->handoff->record_fd<0) {
    throw_code(env,"HANDOFF_CLOSED","Registered lifecycle is closed.");return NULL;
  }return l;
}
static napi_value p7_create_launch(napi_env env,napi_callback_info info) {
  napi_value rec=ps_create_handoff(env,info);if(!rec)return NULL;
  ps_handoff_t *h=ps_handoff_get(env,rec);if(!h)return NULL;
  /* The launch owns the record; detach it from the temporary N-API finalizer. */
  ps_handoff_t *owned=malloc(sizeof(*h));if(!owned)return NULL;*owned=*h;
  h->record_fd=h->directory_fd=h->root_fd=h->v1_fd=-1;
  owned->record.supervisor_pid=0;owned->record.supervisor_start_sec=0;owned->record.supervisor_start_usec=0;
  if(ps_validate_handoff_namespace(owned)||ps_handoff_write(owned->record_fd,&owned->record)!=0){ps_handoff_finalize(env,owned,NULL);throw_errno(env,"prepare registered launch");return NULL;}
  int pair[2];if(socketpair(AF_UNIX,SOCK_DGRAM,0,pair)!=0){ps_handoff_finalize(env,owned,NULL);throw_errno(env,"registered channel");return NULL;}
  if(fcntl(pair[0],F_SETFD,FD_CLOEXEC)||fcntl(pair[1],F_SETFD,FD_CLOEXEC)){close(pair[0]);close(pair[1]);ps_handoff_finalize(env,owned,NULL);throw_errno(env,"registered channel flags");return NULL;}
  p7_launch *l=calloc(1,sizeof(*l));if(!l){close(pair[0]);close(pair[1]);ps_handoff_finalize(env,owned,NULL);return NULL;}
  l->handoff=owned;l->control=pair[0];l->child=pair[1];
  napi_value out,handle,fd;napi_create_object(env,&out);napi_create_external(env,l,p7_launch_finalize,NULL,&handle);
  napi_create_int32(env,l->child,&fd);napi_set_named_property(env,out,"handle",handle);napi_set_named_property(env,out,"childFd",fd);return out;
}
static napi_value p7_register_supervisor(napi_env env,napi_callback_info info) {
  napi_value args[2];size_t argc=2;napi_get_cb_info(env,info,&argc,args,NULL,NULL);
  p7_launch *l=p7_get_launch(env,args[0]);if(!l)return NULL;int32_t pid=0;uint64_t sec=0,usec=0;
  ps_handoff_record_t r;
  if(ps_validate_handoff_namespace(l->handoff)||argc!=2||napi_get_value_int32(env,args[1],&pid)!=napi_ok||pid<=0||
    p7_identity(pid,&sec,&usec)!=1||ps_handoff_read(l->handoff->record_fd,&r)||
    r.stage!=PS_HANDOFF_PREPARED||r.coordinator_pid!=getpid()||l->child<0){
    throw_code(env,"HANDOFF_SUPERVISOR_INVALID","Supervisor identity unavailable.");return NULL;
  }
  r.supervisor_pid=pid;r.supervisor_start_sec=sec;r.supervisor_start_usec=usec;r.stage=PS_HANDOFF_SUPERVISOR_REGISTERED;
  if(ps_validate_handoff_namespace(l->handoff)||ps_handoff_write(l->handoff->record_fd,&r)){throw_errno(env,"register supervisor");return NULL;}
  l->handoff->record=r;close(l->child);l->child=-1;
  if(ps_validate_handoff_namespace(l->handoff)||p7_send(l->control,&r,P7_INIT,l->handoff->record_fd)){throw_errno(env,"delegate exact record");return NULL;}
  return undefined_value(env);
}
static napi_value p7_poll_launch(napi_env env,napi_callback_info info) {
  napi_value arg;size_t argc=1;napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  p7_launch *l=p7_get_launch(env,arg);if(!l)return NULL;
  struct pollfd p={l->control,POLLIN,0};int ready=poll(&p,1,0);
  if(ready<0){throw_errno(env,"poll registered consumer");return NULL;}
  napi_value out;if(!ready){napi_get_boolean(env,false,&out);return out;}
  ps_handoff_record_t r;int unused=-1;
  if(ps_validate_handoff_namespace(l->handoff)||l->armed||p7_receive(l->control,&l->handoff->record,P7_ARMED,0,&unused,0)||
    ps_handoff_read(l->handoff->record_fd,&r)||!p7_same(&r,&l->handoff->record)||
    r.stage!=PS_HANDOFF_REGISTERED||r.receiver_pid<=0){throw_code(env,"HANDOFF_PROTOCOL_INVALID","Consumer registration failed.");return NULL;}
  l->handoff->record=r;l->armed=1;napi_get_boolean(env,true,&out);return out;
}
static napi_value p7_transfer_original(napi_env env,napi_callback_info info) {
  napi_value args[2];size_t argc=2;napi_get_cb_info(env,info,&argc,args,NULL,NULL);
  p7_launch *l=p7_get_launch(env,args[0]);if(!l)return NULL;
  original_handle_t *o=get_original_handle(env,args[1]);if(!o)return NULL;
  ps_handoff_record_t r;struct stat st,named;
  if(ps_validate_handoff_namespace(l->handoff)||!l->armed||l->sent||ps_handoff_read(l->handoff->record_fd,&r)||
    !ps_handoff_same_registration(&r,&l->handoff->record)||r.stage!=PS_HANDOFF_REGISTERED||
    r.coordinator_pid!=getpid()||r.input_type!=1||r.root_device!=(uint64_t)o->device||
    r.root_inode!=(uint64_t)o->root_inode||strcmp(r.marker,o->marker)||
    strcmp(l->handoff->family,o->family)||strcmp(l->handoff->sha,o->sha)||strcmp(l->handoff->byte_size,o->byte_size)||
    fstat(o->file_fd,&st)||fstatat(o->parent_fd,o->base,&named,AT_SYMLINK_NOFOLLOW)||
    st.st_dev!=o->device||st.st_ino!=o->inode||st.st_size!=o->size||
    st.st_mtimespec.tv_sec!=o->mtime.tv_sec||st.st_mtimespec.tv_nsec!=o->mtime.tv_nsec||
    named.st_dev!=o->device||named.st_ino!=o->inode||named.st_nlink!=1||(named.st_mode&0777)!=0400||
    lseek(o->file_fd,0,SEEK_SET)!=0){throw_code(env,"HANDOFF_CONTENT_MISMATCH","Transfer capability changed.");return NULL;}
  int root=open_absolute_directory(o->root_path,0);struct stat root_status;char marker[33];
  int valid=root>=0&&fstat(root,&root_status)==0&&root_status.st_dev==o->device&&
    root_status.st_ino==o->root_inode&&read_marker(root,marker,sizeof(marker),0)==0&&!strcmp(marker,o->marker);
  if(root>=0)close(root);
  if(!valid||ps_handoff_named_identity(l->handoff->directory_fd,l->handoff->record_fd,l->handoff->name)) {
    throw_code(env,"HANDOFF_CONTENT_MISMATCH","Transfer root identity changed.");return NULL;
  }
  l->sent=1;
  if(ps_validate_handoff_namespace(l->handoff)||p7_send(l->control,&r,P7_MEDIA,o->file_fd)){throw_errno(env,"send registered media");return NULL;}
  int file=o->file_fd,parent=o->parent_fd;o->file_fd=o->parent_fd=-1;o->consumed=1;
  int failed=close(file);if(close(parent)!=0)failed=-1;
  if(!failed&&l->test_withhold)return undefined_value(env);
  if(failed||ps_validate_handoff_namespace(l->handoff)||p7_send(l->control,&r,P7_SOURCE_RELEASED,-1)){throw_code(env,"HANDOFF_SOURCE_UNSETTLED","Source release failed.");return NULL;}
  close(l->control);l->control=-1;return undefined_value(env);
}
static napi_value p7_verify_settlement(napi_env env,napi_callback_info info) {
  napi_value arg;size_t argc=1;napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  p7_launch *l=p7_get_launch(env,arg);if(!l)return NULL;ps_handoff_record_t r;
  if(ps_validate_handoff_namespace(l->handoff)||ps_handoff_named_identity(l->handoff->directory_fd,l->handoff->record_fd,l->handoff->name)||
    ps_handoff_read(l->handoff->record_fd,&r)||!ps_handoff_same_registration(&r,&l->handoff->record)||
    r.stage!=PS_HANDOFF_SETTLED||!l->sent){throw_code(env,"HANDOFF_UNSETTLED","Registered consumer is not durably settled.");return NULL;}
  return undefined_value(env);
}
static napi_value p7_close_launch(napi_env env,napi_callback_info info) {
  napi_value arg;size_t argc=1;napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  p7_launch *l=p7_get_launch(env,arg);if(!l)return NULL;
  if(l->control>=0)close(l->control);if(l->child>=0)close(l->child);l->control=l->child=-1;
  ps_handoff_finalize(env,l->handoff,NULL);l->handoff=NULL;return undefined_value(env);
}
static napi_value p7_original_identity(napi_env env,napi_callback_info info) {
  napi_value arg;size_t argc=1;napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  original_handle_t *o=get_original_handle(env,arg);if(!o)return NULL;
  napi_value out;napi_create_object(env,&out);
  const char *keys[]={"mediaRoot","expectedMarkerId","familyId","sha256Hex","byteSize"};
  const char *values[]={o->root_path,o->marker,o->family,o->sha,o->byte_size};
  for(size_t i=0;i<5;i++){napi_value v;napi_create_string_utf8(env,values[i],NAPI_AUTO_LENGTH,&v);napi_set_named_property(env,out,keys[i],v);}
  return out;
}
#ifdef PS_STORAGE_TEST_HOOKS
static napi_value p7_test_withhold(napi_env env,napi_callback_info info) {
  napi_value args[2];size_t argc=2;napi_get_cb_info(env,info,&argc,args,NULL,NULL);
  p7_launch *l=p7_get_launch(env,args[0]);if(!l)return NULL;l->test_withhold=1;
  return p7_transfer_original(env,info);
}
static napi_value p7_test_release(napi_env env,napi_callback_info info) {
  napi_value arg;size_t argc=1;napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  p7_launch *l=p7_get_launch(env,arg);if(!l)return NULL;
  if(!l->sent||!l->test_withhold||p7_send(l->control,&l->handoff->record,P7_SOURCE_RELEASED,-1)) {
    throw_code(env,"HANDOFF_PROTOCOL_INVALID","Invalid test release boundary.");return NULL;
  }
  close(l->control);l->control=-1;l->test_withhold=0;return undefined_value(env);
}
static napi_value p7_test_snapshot(napi_env env,napi_callback_info info) {
  napi_value arg;size_t argc=1;napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  p7_launch *l=p7_get_launch(env,arg);if(!l)return NULL;ps_handoff_record_t r;
  if(ps_handoff_read(l->handoff->record_fd,&r)){throw_errno(env,"inspect test handoff");return NULL;}
  napi_value out,v;napi_create_object(env,&out);
  napi_create_uint32(env,r.stage,&v);napi_set_named_property(env,out,"stage",v);
  napi_create_int32(env,r.supervisor_pid,&v);napi_set_named_property(env,out,"supervisorPid",v);
  napi_create_int32(env,r.receiver_pid,&v);napi_set_named_property(env,out,"consumerPid",v);
  return out;
}
#endif
#endif
