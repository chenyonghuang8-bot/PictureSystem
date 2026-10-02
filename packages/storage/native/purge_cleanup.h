/* Purge-only exact Derived normalization. Never called by ordinary recovery.
 * Root/store and both exclusive content guards are native opaque capabilities.
 * No caller pathname, recursive operation, or Original deletion. */
#ifndef PS_PURGE_CLEANUP_H
#define PS_PURGE_CLEANUP_H
#include <math.h>
static napi_value pg_clock(napi_env env,napi_callback_info info) {
  (void)info;napi_value result;napi_create_double(env,(double)verifier_now_ms(),&result);return result;
}
#ifdef PS_STORAGE_TEST_HOOKS
static napi_value pg_fail_fsync(napi_env env,napi_callback_info info) {
  napi_value args[1];size_t argc=1;napi_get_cb_info(env,info,&argc,args,NULL,NULL);
  derived_store_t *store=argc==1?derived_get_store(env,args[0]):NULL;
  if(!store)return NULL;
  pthread_mutex_lock(&store->mutex);store->fail_next_purge_fsync=1;pthread_mutex_unlock(&store->mutex);
  napi_value result;napi_get_undefined(env,&result);return result;
}
#endif

static int pg_text(napi_env env, napi_value value, const char *key, char *out, size_t cap) {
  napi_value item;
  return napi_get_named_property(env,value,key,&item)==napi_ok ? get_string(env,item,out,cap) : -1;
}

/* Strict missing-parent classification: ENOTDIR, symlink and I/O are unsafe.
 * Synchronize the nearest existing parent even on an absence-only recovery. */
static int pg_parent(int base, dev_t device, const char **parts, int count) {
  int parent=dup(base);
  if(parent<0)return -1;
  for(int i=0;i<count;i++) {
    struct stat named,opened;
    if(fstatat(parent,parts[i],&named,AT_SYMLINK_NOFOLLOW)) {
      int saved=errno;
      if(saved==ENOENT && sync_directory_fd(parent)==0) {close(parent);return -2;}
      close(parent);errno=saved;return -1;
    }
    if(!S_ISDIR(named.st_mode)||named.st_dev!=device||!owned_by_caller(&named)||
      (named.st_mode&07777)!=0700) {close(parent);errno=EPERM;return -1;}
    int next=openat(parent,parts[i],O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    if(next<0||fstat(next,&opened)||opened.st_dev!=named.st_dev||opened.st_ino!=named.st_ino||
      validate_no_extended_acl(next)) {if(next>=0)close(next);close(parent);errno=EPERM;return -1;}
    close(parent);parent=next;
  }
  return parent;
}

/* The held writer must belong to the currently named child namespace, not a
 * formerly valid directory moved away while its descriptors remain open. */
static int pg_derived_namespace(storage_root_t *root, derived_store_t *store) {
  if(!root||!store||root->root_fd<0||derived_require_root(store))return -1;
  const char *parts[]={"derived"};
  int current=pg_parent(root->root_fd,store->device,parts,1);
  struct stat held,opened,named;ino_t lock_inode;
  int valid=current>=0&&!fstat(store->derived_fd,&held)&&!fstat(current,&opened)&&
    held.st_dev==opened.st_dev&&held.st_ino==opened.st_ino&&
    opened.st_dev==store->device&&opened.st_ino==store->derived_inode&&
    !derived_validate_lock(current,store->lock_fd,store->device,&lock_inode)&&lock_inode==store->lock_inode&&
    !fstatat(root->root_fd,"derived",&named,AT_SYMLINK_NOFOLLOW)&&
    S_ISDIR(named.st_mode)&&named.st_dev==opened.st_dev&&named.st_ino==opened.st_ino&&
    owned_by_caller(&named)&&(named.st_mode&07777)==0700;
  if(current>=0&&close(current))valid=0;
  return valid?0:-1;
}

static int pg_authority(storage_root_t *root, derived_store_t *store, ps_coord_t *life, ps_coord_t *read) {
  if(!root||!store||!life||!read||!life->locked||!read->locked||
    !life->exclusive||!read->exclusive||life->basename[65]!='L'||read->basename[65]!='R'||
    memcmp(life->coordination_id,read->coordination_id,32)||
    root->root_fd<0||root->lock_fd<0||derived_require_root(store))return -1;
  struct stat original,fresh,writer,named;ino_t life_inode,read_inode;
  int fd=open_absolute_directory(root->canonical_path,0);
  int valid=fd>=0&&!fstat(fd,&fresh)&&!fstat(root->root_fd,&original)&&
    fresh.st_dev==original.st_dev&&fresh.st_ino==original.st_ino&&
    original.st_dev==store->device&&original.st_ino==store->root_inode&&
    read->root_device==store->device&&read->root_inode==store->root_inode&&
    !strcmp(read->marker,store->marker)&&!strcmp(life->marker,store->marker)&&
    !fstat(root->lock_fd,&writer)&&!fstatat(root->root_fd,".writer.lock",&named,AT_SYMLINK_NOFOLLOW)&&
    S_ISREG(writer.st_mode)&&writer.st_ino==named.st_ino&&writer.st_dev==named.st_dev&&
    writer.st_nlink==1&&owned_by_caller(&writer)&&(writer.st_mode&07777)==0600&&
    !validate_no_extended_acl(root->lock_fd)&&
    !ps_coord_validate_file(life,&life_inode)&&life_inode==life->lock_inode&&
    !ps_coord_validate_file(read,&read_inode)&&read_inode==read->lock_inode&&
    !pg_derived_namespace(root,store);
  if(fd>=0)close(fd);
  return valid ? 0 : -1;
}

/* Purge inventory recognizes empty protocol directories left by a durable
 * unlink. Ordinary recovery deliberately keeps its conservative scan rules. */
static int pg_scan(napi_env env,int parent,dev_t device,int depth,const char *job,
                   const char *epoch,const char *generation,napi_value output,uint32_t *count,uint32_t *budget) {
  int duplicate=openat(parent,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  DIR *directory=duplicate<0?NULL:fdopendir(duplicate);
  if(!directory){if(duplicate>=0)close(duplicate);return -1;}
  struct dirent *entry;int bad=0;errno=0;
  while((entry=readdir(directory))!=NULL) {
    if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,"..")){errno=0;continue;}
    if((*budget)++>=4096){bad=1;break;}
    char canonical[32];
    if(depth==2||depth==5) {
      int final=depth==5;const char *kind=NULL;
      if(!strcmp(entry->d_name,final?"thumbnail.webp":"thumbnail.part"))kind="THUMBNAIL";
      else if(!strcmp(entry->d_name,final?"preview.webp":"preview.part"))kind="PREVIEW";
      if(!kind){bad=1;break;}
      struct stat named;
      if(fstatat(parent,entry->d_name,&named,AT_SYMLINK_NOFOLLOW)||!S_ISREG(named.st_mode)||
        named.st_dev!=device||!owned_by_caller(&named)||named.st_nlink!=1||
        ((named.st_mode&07777)!=0400&&(final||(named.st_mode&07777)!=0600))) {bad=1;break;}
      int fd=openat(parent,entry->d_name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
      struct stat opened;
      if(fd<0||fstat(fd,&opened)||opened.st_dev!=named.st_dev||opened.st_ino!=named.st_ino||validate_no_extended_acl(fd))bad=1;
      if(fd>=0&&close(fd))bad=1;
      if(bad)break;
      napi_value item,value;napi_create_object(env,&item);
      const char *keys[]={"name","jobId","epoch","generation","kind"};
      const char *values[]={final?"FINAL":"TEMP",job,epoch,generation,kind};
      for(int i=0;i<5;i++){napi_create_string_utf8(env,values[i],NAPI_AUTO_LENGTH,&value);napi_set_named_property(env,item,keys[i],value);}
      napi_set_element(env,output,(*count)++,item);
    } else {
      int valid=depth==3?!strcmp(entry->d_name,"r1"):
        depth==1?entry->d_name[0]=='e'&&!canonical_u64(entry->d_name+1,canonical,sizeof(canonical)):
        depth==4?entry->d_name[0]=='g'&&!canonical_u64(entry->d_name+1,canonical,sizeof(canonical)):0;
      if(!valid){bad=1;break;}
      const char *parts[]={entry->d_name};int child=pg_parent(parent,device,parts,1);
      if(child<0){bad=1;break;}
      bad=pg_scan(env,child,device,depth+1,job,depth==1?canonical:epoch,
        depth==4?canonical:generation,output,count,budget);
      if(close(child))bad=1;
      if(bad)break;
    }
    errno=0;
  }
  if(errno)bad=1;
  if(closedir(directory))bad=1;
  return bad?-1:0;
}
static napi_value pg_inventory(napi_env env,napi_callback_info info) {
  napi_value args[5];size_t argc=5;napi_get_cb_info(env,info,&argc,args,NULL,NULL);
  if(argc!=5){throw_code(env,"PURGE_IDENTITY","Purge capabilities required.");return NULL;}
  storage_root_t *root=get_root(env,args[0]);derived_store_t *store=derived_get_store(env,args[1]);
  ps_coord_t *life=ps_coord_get(env,args[2]),*read=ps_coord_get(env,args[3]);
  if(!root||!store||!life||!read)return NULL;
  char family[32],media[32],canonical[32];napi_value jobs;
  uint32_t job_count=0;
  if(pg_text(env,args[4],"familyId",family,sizeof(family))||pg_text(env,args[4],"mediaId",media,sizeof(media))||
    canonical_u64(family,canonical,sizeof(canonical))||canonical_u64(media,canonical,sizeof(canonical))||
    strcmp(family,read->family)||pg_authority(root,store,life,read)||
    napi_get_named_property(env,args[4],"jobs",&jobs)!=napi_ok||napi_get_array_length(env,jobs,&job_count)!=napi_ok||job_count>4096) {
    throw_code(env,"PURGE_IDENTITY","Purge inventory identity rejected.");return NULL;
  }
  pthread_mutex_lock(&store->mutex);int bad=0;
  for(int i=0;i<DERIVED_LIVE_WRITERS;i++)if(store->live[i]&&!strcmp(store->live[i]->family,family)&&!strcmp(store->live[i]->media,media))bad=1;
  napi_value output;napi_create_array(env,&output);uint32_t count=0,budget=0;
  const char *finals[]={family,media};int fd=pg_parent(store->derived_fd,store->device,finals,2);
  if(fd==-1)bad=1;
  if(!bad&&fd>=0)bad=pg_scan(env,fd,store->device,3,"","","",output,&count,&budget);
  if(fd>=0&&close(fd))bad=1;
  for(uint32_t i=0;!bad&&i<job_count;i++) {
    napi_value value;char job[32];
    if(napi_get_element(env,jobs,i,&value)!=napi_ok||get_string(env,value,job,sizeof(job))||canonical_u64(job,canonical,sizeof(canonical))){bad=1;break;}
    const char *temps[]={".tmp",job};fd=pg_parent(store->derived_fd,store->device,temps,2);
    if(fd==-1)bad=1;
    if(!bad&&fd>=0)bad=pg_scan(env,fd,store->device,1,job,"","",output,&count,&budget);
    if(fd>=0&&close(fd))bad=1;
  }
  if(pg_authority(root,store,life,read))bad=1;
  pthread_mutex_unlock(&store->mutex);
  if(bad){throw_code(env,"PURGE_INVENTORY_INCOMPLETE","Purge inventory proof failed.");return NULL;}
  return output;
}

/* Inspect or remove one exact temp/final; removal requires expected fresh fact.
 * JS internal worker owns SQL authorization and one-shot lease permit. */
static napi_value pg_derived(napi_env env,napi_callback_info info) {
  napi_value args[5];size_t argc=5;
  napi_get_cb_info(env,info,&argc,args,NULL,NULL);
  if(argc!=5){throw_code(env,"PURGE_IDENTITY","Purge capabilities required.");return NULL;}
  storage_root_t *root=get_root(env,args[0]);derived_store_t *store=derived_get_store(env,args[1]);
  ps_coord_t *life=ps_coord_get(env,args[2]),*read=ps_coord_get(env,args[3]);
  if(!root||!store||!life||!read)return NULL;
  char family[32],media[32],generation[32],job[32],epoch[32],kind[12],action[24];
  char canonical[32],gen_name[40],epoch_name[40],leaf[24];uint32_t cap=0;
  if(pg_text(env,args[4],"familyId",family,sizeof(family))||
    pg_text(env,args[4],"mediaId",media,sizeof(media))||pg_text(env,args[4],"generation",generation,sizeof(generation))||
    pg_text(env,args[4],"jobId",job,sizeof(job))||pg_text(env,args[4],"epoch",epoch,sizeof(epoch))||
    pg_text(env,args[4],"kind",kind,sizeof(kind))||pg_text(env,args[4],"action",action,sizeof(action))||
    canonical_u64(family,canonical,sizeof(canonical))||canonical_u64(media,canonical,sizeof(canonical))||
    canonical_u64(generation,canonical,sizeof(canonical))||canonical_u64(job,canonical,sizeof(canonical))||
    canonical_u64(epoch,canonical,sizeof(canonical))||derived_leaf_name(kind,leaf,sizeof(leaf),&cap)||
    strcmp(family,read->family)||pg_authority(root,store,life,read)) {
    throw_code(env,"PURGE_IDENTITY","Purge identity rejected.");return NULL;
  }
  int final=!strcmp(action,"FINAL_INSPECT")||!strcmp(action,"FINAL_REMOVE");
  int remove=!strcmp(action,"TEMP_REMOVE")||!strcmp(action,"FINAL_REMOVE");
  if(!final&&!remove&&strcmp(action,"TEMP_INSPECT")) {throw_code(env,"PURGE_IDENTITY","Invalid purge action.");return NULL;}
  snprintf(gen_name,sizeof(gen_name),"g%s",generation);snprintf(epoch_name,sizeof(epoch_name),"e%s",epoch);
  if(final&&recovery_kind_leaf(kind,1,leaf,sizeof(leaf)))return NULL;
  const char *temps[]={".tmp",job,epoch_name};const char *finals[]={family,media,"r1",gen_name};
  pthread_mutex_lock(&store->mutex);
  for(int i=0;i<DERIVED_LIVE_WRITERS;i++) {
    derived_writer_t *w=store->live[i];
    if(w&&((!strcmp(w->job,job)&&!strcmp(w->epoch,epoch)&&!strcmp(w->kind,kind))||
      (!strcmp(w->family,family)&&!strcmp(w->media,media)&&!strcmp(w->generation,generation)&&
       !strcmp(w->recipe,"1")&&!strcmp(w->kind,kind)))) {
      pthread_mutex_unlock(&store->mutex);throw_code(env,"PURGE_LIVE_HANDLE","Purge target is occupied.");return NULL;
    }
  }
  int parent=pg_parent(store->derived_fd,store->device,final?finals:temps,final?4:3);
  char bytes[32]="",device[32]="",inode[32]="",mode[8]="",nlink[8]="",sha[65]="";
  const char *classification="ABSENT",*failure="PURGE_FILESYSTEM_UNCERTAIN";struct stat named,opened,again;int fd=-1,unsafe=0;
  if(parent==-1)unsafe=1;
  else if(parent>=0&&fstatat(parent,leaf,&named,AT_SYMLINK_NOFOLLOW)) {
    if(errno!=ENOENT||sync_directory_fd(parent))unsafe=1;
  } else if(parent>=0) {
    classification="REGULAR";
    if(!S_ISREG(named.st_mode)||named.st_nlink!=1||named.st_dev!=store->device||
      !owned_by_caller(&named)||named.st_size<0||(uint64_t)named.st_size>cap||
      ((named.st_mode&07777)!=0400&&(final||(named.st_mode&07777)!=0600))||
      ((final||(named.st_mode&07777)==0400)&&named.st_size==0))unsafe=1;
    if(!unsafe)fd=openat(parent,leaf,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
    if(!unsafe&&(fd<0||fstat(fd,&opened)||opened.st_dev!=named.st_dev||opened.st_ino!=named.st_ino||
      validate_no_extended_acl(fd)))unsafe=1;
    unsigned char digest[32];
    if(!unsafe&&(derived_hash_fd(fd,named.st_size,digest)||fstat(fd,&opened)||
      fstatat(parent,leaf,&again,AT_SYMLINK_NOFOLLOW)||again.st_dev!=named.st_dev||again.st_ino!=named.st_ino||
      opened.st_size!=named.st_size||opened.st_mtimespec.tv_sec!=named.st_mtimespec.tv_sec||
      opened.st_mtimespec.tv_nsec!=named.st_mtimespec.tv_nsec||opened.st_mode!=named.st_mode||
      opened.st_nlink!=1||!owned_by_caller(&opened)||validate_no_extended_acl(fd)||
      opened.st_ctimespec.tv_sec!=named.st_ctimespec.tv_sec||opened.st_ctimespec.tv_nsec!=named.st_ctimespec.tv_nsec))unsafe=1;
    if(!unsafe) {
      derived_digest_hex(digest,sha);
      recovery_format_stat(&named,bytes,sizeof(bytes),device,sizeof(device),inode,sizeof(inode),mode,sizeof(mode),nlink,sizeof(nlink));
    }
  }
  if(!unsafe&&remove) {
    napi_value deadline_value;double deadline=0;
    char original_sha[65],original_bytes[32];
    if(pg_text(env,args[4],"originalSha256Hex",original_sha,sizeof(original_sha))||
      pg_text(env,args[4],"originalByteSize",original_bytes,sizeof(original_bytes))||
      strcmp(original_sha,read->sha)||strcmp(original_bytes,read->byte_size)){unsafe=1;failure="PURGE_KEY_PROOF";}
    if(napi_get_named_property(env,args[4],"permitDeadlineMs",&deadline_value)!=napi_ok||
      napi_get_value_double(env,deadline_value,&deadline)!=napi_ok||
      !isfinite(deadline)){unsafe=1;failure="PURGE_PERMIT_FIELD";}
    else if(deadline<=verifier_now_ms()){unsafe=1;failure="PURGE_PERMIT_EXPIRED";}
    else if(deadline>verifier_now_ms()+90000){unsafe=1;failure="PURGE_PERMIT_WINDOW";}
    char expected_sha[65],expected_device[32],expected_inode[32],expected_bytes[32],expected_mode[8];
    if(strcmp(classification,"REGULAR")||pg_text(env,args[4],"sha256Hex",expected_sha,sizeof(expected_sha))||
      pg_text(env,args[4],"device",expected_device,sizeof(expected_device))||pg_text(env,args[4],"inode",expected_inode,sizeof(expected_inode))||
      pg_text(env,args[4],"byteSize",expected_bytes,sizeof(expected_bytes))||pg_text(env,args[4],"mode",expected_mode,sizeof(expected_mode))||
      strcmp(sha,expected_sha)||strcmp(device,expected_device)||strcmp(inode,expected_inode)||strcmp(bytes,expected_bytes)||strcmp(mode,expected_mode))unsafe=1;
    /* Recheck the opposite name under the same native serialization. A final
     * appearing after a temp-only proof is never permission to remove it. */
    char opposite_leaf[24],opposite_sha[65],opposite_bytes[32],opposite_inode[32],opposite_device[32],actual_inode[32],actual_device[32];
    int opposite=pg_parent(store->derived_fd,store->device,final?temps:finals,final?3:4);
    if(recovery_kind_leaf(kind,!final,opposite_leaf,sizeof(opposite_leaf))||opposite==-1)unsafe=1;
    if(!unsafe&&opposite>=0) {
      struct stat other;
      if(fstatat(opposite,opposite_leaf,&other,AT_SYMLINK_NOFOLLOW)==0) {
        snprintf(actual_inode,sizeof(actual_inode),"%llu",(unsigned long long)other.st_ino);
        snprintf(actual_device,sizeof(actual_device),"%llu",(unsigned long long)other.st_dev);
        if(final||pg_text(env,args[4],"pairedSha256Hex",opposite_sha,sizeof(opposite_sha))||
          pg_text(env,args[4],"pairedByteSize",opposite_bytes,sizeof(opposite_bytes))||
          pg_text(env,args[4],"pairedInode",opposite_inode,sizeof(opposite_inode))||
          pg_text(env,args[4],"pairedDevice",opposite_device,sizeof(opposite_device))||
          strcmp(actual_inode,opposite_inode)||strcmp(actual_device,opposite_device)||
          !S_ISREG(other.st_mode)||other.st_nlink!=1||!owned_by_caller(&other)||
          other.st_dev!=store->device||(other.st_mode&07777)!=0400||other.st_size<=0||
          strcmp(mode,"400")||strcmp(opposite_sha,sha)||
          strcmp(opposite_bytes,bytes)||recovery_hash_named(opposite,opposite_leaf,&other,opposite_sha)||
          strcmp(opposite_sha,sha))unsafe=1;
      } else if(errno!=ENOENT||sync_directory_fd(opposite))unsafe=1;
    }
    if(opposite>=0)close(opposite);
    if(!unsafe&&(deadline<=verifier_now_ms()||pg_authority(root,store,life,read)||unlinkat(parent,leaf,0)||
      fstatat(parent,leaf,&again,AT_SYMLINK_NOFOLLOW)==0||errno!=ENOENT))unsafe=1;
#ifdef PS_STORAGE_TEST_HOOKS
    if(!unsafe&&store->fail_next_purge_fsync){store->fail_next_purge_fsync=0;unsafe=1;}
#endif
    if(!unsafe&&sync_directory_fd(parent))unsafe=1;
  }
  if(pg_authority(root,store,life,read))unsafe=1;
  if(fd>=0&&close(fd))unsafe=1;
  if(parent>=0&&close(parent))unsafe=1;
  pthread_mutex_unlock(&store->mutex);
  if(unsafe){throw_code(env,failure,"Purge filesystem proof failed.");return NULL;}
  return recovery_fact_object(env,remove?"ABSENT":classification,bytes,device,inode,mode,nlink,sha);
}
#endif
