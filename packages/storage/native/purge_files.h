#ifndef PS_PURGE_FILES_H
#define PS_PURGE_FILES_H
/* Manifest-only physical operations. No pathname/FD enters from JavaScript. */
static int pf_sync(derived_store_t *store,int fd) {
#ifdef PS_STORAGE_TEST_HOOKS
  if(store->fail_next_purge_fsync){store->fail_next_purge_fsync=0;errno=EIO;return -1;}
#else
  (void)store;
#endif
  return sync_directory_fd(fd);
}
static int pf_fact(int parent,const char *name,dev_t device,const char *sha,const char *bytes,struct stat *fact) {
  if(parent==-2)return 0;
  if(parent<0)return -1;
  if(fstatat(parent,name,fact,AT_SYMLINK_NOFOLLOW))return errno==ENOENT&&!sync_directory_fd(parent)?0:-1;
  char size[32],hash[65];snprintf(size,sizeof(size),"%llu",(unsigned long long)fact->st_size);
  if(!S_ISREG(fact->st_mode)||fact->st_nlink!=1||!owned_by_caller(fact)||fact->st_dev!=device||
    (fact->st_mode&07777)!=0400||fact->st_size<=0||strcmp(size,bytes))return -1;
  int fd=openat(parent,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);struct stat opened,again;unsigned char digest[32];
  int bad=fd<0||fstat(fd,&opened)||opened.st_dev!=fact->st_dev||opened.st_ino!=fact->st_ino||
    validate_no_extended_acl(fd)||derived_hash_fd(fd,fact->st_size,digest)||fstat(fd,&opened)||
    fstatat(parent,name,&again,AT_SYMLINK_NOFOLLOW)||again.st_dev!=fact->st_dev||again.st_ino!=fact->st_ino||
    opened.st_size!=fact->st_size||opened.st_mode!=fact->st_mode||opened.st_nlink!=1||!owned_by_caller(&opened)||
    opened.st_mtimespec.tv_sec!=fact->st_mtimespec.tv_sec||opened.st_mtimespec.tv_nsec!=fact->st_mtimespec.tv_nsec||
    opened.st_ctimespec.tv_sec!=fact->st_ctimespec.tv_sec||opened.st_ctimespec.tv_nsec!=fact->st_ctimespec.tv_nsec||validate_no_extended_acl(fd);
  if(!bad){derived_digest_hex(digest,hash);bad=strcmp(hash,sha)!=0;}
  if(fd>=0&&close(fd))bad=1;return bad?-1:1;
}
static napi_value pf_owners(napi_env env,napi_callback_info info) {
  napi_value args[2];size_t argc=2;napi_get_cb_info(env,info,&argc,args,NULL,NULL);
  storage_root_t *root=argc==2?get_root(env,args[0]):NULL;
  derived_store_t *store=argc==2?derived_get_store(env,args[1]):NULL;
  struct stat opened,named,lock;int fd=root?open_absolute_directory(root->canonical_path,0):-1;
  int bad=!root||!store||root->root_fd<0||root->lock_fd<0||derived_require_root(store)||fd<0||
    fstat(fd,&named)||fstat(root->root_fd,&opened)||named.st_dev!=opened.st_dev||named.st_ino!=opened.st_ino||
    opened.st_dev!=store->device||opened.st_ino!=store->root_inode||
    fstat(root->lock_fd,&lock)||fstatat(root->root_fd,".writer.lock",&named,AT_SYMLINK_NOFOLLOW)||
    lock.st_dev!=named.st_dev||lock.st_ino!=named.st_ino||!S_ISREG(lock.st_mode)||lock.st_nlink!=1||
    (lock.st_mode&07777)!=0600||!owned_by_caller(&lock)||validate_no_extended_acl(root->lock_fd)||
    pg_derived_namespace(root,store);
  if(fd>=0&&close(fd))bad=1;
  if(bad){throw_code(env,"PURGE_WRITER_REQUIRED","Purge owners unavailable.");return NULL;}
  napi_value value;napi_get_undefined(env,&value);return value;
}
static napi_value pf_execute(napi_env env,napi_callback_info info) {
  napi_value args[5];size_t argc=5;napi_get_cb_info(env,info,&argc,args,NULL,NULL);
  if(argc!=5){throw_code(env,"PURGE_IDENTITY","Purge capabilities required.");return NULL;}
  storage_root_t *root=get_root(env,args[0]);derived_store_t *store=derived_get_store(env,args[1]);
  ps_coord_t *life=ps_coord_get(env,args[2]),*read=ps_coord_get(env,args[3]);if(!root||!store||!life||!read)return NULL;
  char action[24],stage[24],family[32],intent[32],id[32],file_kind[16],sha[65],bytes[32],marker[33],device[32],
    original_sha[65],original_bytes[32],canon[32],slot[33],leaf[128],media[32],generation[32],gen[40],kind[16];
  napi_value dv;double deadline=0;uint64_t intent_number,file_number;
  if(pg_text(env,args[4],"action",action,sizeof(action))||pg_text(env,args[4],"stage",stage,sizeof(stage))||
    pg_text(env,args[4],"familyId",family,sizeof(family))||canonical_u64(family,canon,sizeof(canon))||
    pg_text(env,args[4],"intentId",intent,sizeof(intent))||canonical_u64(intent,canon,sizeof(canon))||
    pg_text(env,args[4],"id",id,sizeof(id))||canonical_u64(id,canon,sizeof(canon))||
    pg_text(env,args[4],"fileKind",file_kind,sizeof(file_kind))||pg_text(env,args[4],"sha256Hex",sha,sizeof(sha))||
    pg_text(env,args[4],"byteSize",bytes,sizeof(bytes))||canonical_u64(bytes,canon,sizeof(canon))||
    pg_text(env,args[4],"markerId",marker,sizeof(marker))||pg_text(env,args[4],"device",device,sizeof(device))||
    pg_text(env,args[4],"originalSha256Hex",original_sha,sizeof(original_sha))||
    pg_text(env,args[4],"originalByteSize",original_bytes,sizeof(original_bytes))||strcmp(family,read->family)||
    strcmp(original_sha,read->sha)||strcmp(original_bytes,read->byte_size)||strcmp(marker,store->marker)||
    pg_authority(root,store,life,read)||napi_get_named_property(env,args[4],"permitDeadlineMs",&dv)!=napi_ok||
    napi_get_value_double(env,dv,&deadline)!=napi_ok||!isfinite(deadline)||deadline<=verifier_now_ms()||deadline>verifier_now_ms()+90000) {
    throw_code(env,"PURGE_AUTHORITY","Purge manifest authority rejected.");return NULL;
  }
  char actual_device[32];snprintf(actual_device,sizeof(actual_device),"%llu",(unsigned long long)store->device);
  unsigned char digest[32];if(strcmp(device,actual_device)||derived_parse_sha256(sha,digest)) {throw_code(env,"PURGE_IDENTITY","Purge manifest identity rejected.");return NULL;}
  intent_number=strtoull(intent,NULL,10);file_number=strtoull(id,NULL,10);
  snprintf(slot,sizeof(slot),"%016llx%016llx",(unsigned long long)intent_number,(unsigned long long)file_number);
  int original=!strcmp(file_kind,"ORIGINAL"),source=-1,q=-1,p=-1,bad=0;struct stat a,b;
  pthread_mutex_lock(&store->mutex);
  if(original) {
    if(strcmp(sha,read->sha)||strcmp(bytes,read->byte_size))bad=1;
    char first[3]={sha[0],sha[1],0},second[3]={sha[2],sha[3],0};
    const char *parts[]={"originals",family,first,second};source=pg_parent(root->root_fd,store->device,parts,4);
    snprintf(leaf,sizeof(leaf),"%s-%s",sha,bytes);
  } else if(!strcmp(file_kind,"DERIVED")) {
    if(pg_text(env,args[4],"mediaId",media,sizeof(media))||canonical_u64(media,canon,sizeof(canon))||
      pg_text(env,args[4],"generation",generation,sizeof(generation))||canonical_u64(generation,canon,sizeof(canon))||
      pg_text(env,args[4],"kind",kind,sizeof(kind))||recovery_kind_leaf(kind,1,leaf,sizeof(leaf)))bad=1;
    for(int i=0;i<DERIVED_LIVE_WRITERS;i++)if(store->live[i]&&!strcmp(store->live[i]->family,family)&&!strcmp(store->live[i]->media,media))bad=1;
    snprintf(gen,sizeof(gen),"g%s",generation);const char *parts[]={family,media,"r1",gen};source=pg_parent(store->derived_fd,store->device,parts,4);
  } else bad=1;
  /* Provision only the fixed private namespace, synchronizing each parent. */
  const char *purge[]={".purge"};p=pg_parent(root->root_fd,store->device,purge,1);
  if(p==-2&&!strcmp(action,"QUARANTINE")) {
    if(mkdirat(root->root_fd,".purge",0700)||sync_directory_fd(root->root_fd))bad=1;
    p=pg_parent(root->root_fd,store->device,purge,1);
  }
  if(p>=0){const char *version[]={"v1"};q=pg_parent(p,store->device,version,1);
    if(q==-2&&!strcmp(action,"QUARANTINE")){if(mkdirat(p,"v1",0700)||sync_directory_fd(p))bad=1;q=pg_parent(p,store->device,version,1);}}
  else q=p;
  int canonical=bad?-1:pf_fact(source,leaf,store->device,sha,bytes,&a),quarantine=bad?-1:pf_fact(q,slot,store->device,sha,bytes,&b);
  if(canonical<0||quarantine<0||canonical+quarantine>1)bad=1;
  const char *result=NULL;
  if(!bad&&!strcmp(action,"QUARANTINE")&&!strcmp(stage,"CATALOGUED")) {
    if(canonical==1) {
      if(q<0||deadline<=verifier_now_ms()||pg_authority(root,store,life,read)||
        renameatx_np(source,leaf,q,slot,RENAME_EXCL|RENAME_NOFOLLOW_ANY|RENAME_RESOLVE_BENEATH)||
        pf_sync(store,source)||sync_directory_fd(q)||pf_fact(q,slot,store->device,sha,bytes,&b)!=1||b.st_ino!=a.st_ino||b.st_dev!=a.st_dev)bad=1;
      else result="QUARANTINED";
    } else if(quarantine==1){if(sync_directory_fd(q)||(source>=0&&sync_directory_fd(source)))bad=1;else result="QUARANTINED";}
    else if(!original)result="ABSENT_DERIVED";else bad=1;
  } else if(!bad&&!strcmp(action,"UNLINK")&&!strcmp(stage,"UNLINK_ARMED")) {
    char stored_slot[33],stored_device[32],stored_inode[32],inode[32];
    if(pg_text(env,args[4],"slotHex",stored_slot,sizeof(stored_slot))||strcmp(stored_slot,slot)||
      pg_text(env,args[4],"quarantineDevice",stored_device,sizeof(stored_device))||strcmp(stored_device,device)||
      pg_text(env,args[4],"quarantineInode",stored_inode,sizeof(stored_inode))||canonical_u64(stored_inode,canon,sizeof(canon))||canonical)bad=1;
    if(!bad&&quarantine==1) {
      snprintf(inode,sizeof(inode),"%llu",(unsigned long long)b.st_ino);
      if(strcmp(inode,stored_inode)||fstatat(q,slot,&a,AT_SYMLINK_NOFOLLOW)||a.st_ino!=b.st_ino||a.st_dev!=b.st_dev||a.st_nlink!=1||deadline<=verifier_now_ms()||pg_authority(root,store,life,read)||unlinkat(q,slot,0)||
        fstatat(q,slot,&a,AT_SYMLINK_NOFOLLOW)==0||errno!=ENOENT||pf_sync(store,q))bad=1;
    } else if(!bad&&q>=0&&sync_directory_fd(q))bad=1;
    if(!bad)result="REMOVED";
  } else if(!bad&&!strcmp(action,"VERIFY")&&(!strcmp(stage,"QUARANTINED")||!strcmp(stage,"REMOVED")||!strcmp(stage,"ABSENT_DERIVED"))) {
    if(canonical||(!strcmp(stage,"QUARANTINED")?quarantine!=1:quarantine!=0))bad=1;
    if(!bad&&!strcmp(stage,"QUARANTINED")) {
      char inode[32],expected[32];snprintf(inode,sizeof(inode),"%llu",(unsigned long long)b.st_ino);
      if(pg_text(env,args[4],"quarantineInode",expected,sizeof(expected))||strcmp(inode,expected))bad=1;
    }
    if(!bad)result=stage;
  } else bad=1;
  char inode[32]="";if(result&&!strcmp(result,"QUARANTINED"))snprintf(inode,sizeof(inode),"%llu",(unsigned long long)b.st_ino);
  if(pg_authority(root,store,life,read))bad=1;
  if(source>=0&&close(source))bad=1;if(q>=0&&close(q))bad=1;if(p>=0&&close(p))bad=1;
  pthread_mutex_unlock(&store->mutex);
  if(bad){throw_code(env,"PURGE_FILESYSTEM_UNCERTAIN","Purge physical proof failed.");return NULL;}
  napi_value output,value;napi_create_object(env,&output);
  const char *keys[]={"stage","device","inode"},*values[]={result,device,inode};
  for(int i=0;i<3;i++){napi_create_string_utf8(env,values[i],NAPI_AUTO_LENGTH,&value);napi_set_named_property(env,output,keys[i],value);}return output;
}
#endif
