#ifndef PS_OPERATION_BRIDGE_H
#define PS_OPERATION_BRIDGE_H
#define OP_BRIDGE_MAGIC UINT64_C(0x4f50425249444731)
#define OP_BRIDGE_LIMIT 4096
/* Immutable descriptor of a durable original handoff. No FD is delegated. */
typedef struct {
  uint64_t magic, terminal, control_device, control_inode, control_lock_inode;
  uint64_t record_device, record_inode;
  char deployment[37], launch_id[33], root_path[PATH_MAX];
  ps_handoff_record_t prepared;
  unsigned char checksum[32];
} op_bridge_record;
static void op_bridge_checksum(op_bridge_record *r) {
  memset(r->checksum,0,32);CC_SHA256(r,(CC_LONG)sizeof(*r),r->checksum);
}
static int op_bridge_name(const char *name) {
  return strlen(name)==39&&!memcmp(name,"bridge.",7)&&ps_coord_hex(name+7,32)==0;
}
static int op_bridge_read(ps_operation_gate *g,const char *name,op_bridge_record *r,struct stat *st) {
  if(op_validate(g)||!op_bridge_name(name))return -1;
  int fd=openat(g->directory_fd,name,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
  if(fd<0)return -1;
  int bad=!op_valid_file(fd,st)||st->st_size!=(off_t)sizeof(*r)||
    pread(fd,r,sizeof(*r),0)!=(ssize_t)sizeof(*r)||ps_handoff_named_identity(g->directory_fd,fd,name);
  close(fd);if(bad)return -1;
  unsigned char saved[32];memcpy(saved,r->checksum,32);op_bridge_checksum(r);
  if(memcmp(saved,r->checksum,32)||r->magic!=OP_BRIDGE_MAGIC||r->terminal>1||
    r->control_device!=(uint64_t)g->device||r->control_inode!=(uint64_t)g->directory_inode||
    r->control_lock_inode!=(uint64_t)g->lock_inode||r->deployment[36]||strcmp(r->deployment,g->deployment)||
    r->launch_id[32]||strcmp(r->launch_id,name+7)||r->root_path[PATH_MAX-1]||r->root_path[0]!='/'||
    !ps_handoff_valid(&r->prepared)||r->prepared.stage!=PS_HANDOFF_PREPARED||
    r->prepared.supervisor_pid||r->prepared.receiver_pid)return -1;
  return 0;
}
static int op_bridge_handoff(const op_bridge_record *bridge,ps_handoff_record_t *current) {
  int root=open_absolute_directory(bridge->root_path,0),v1=-1,ledger=-1,fd=-1;
  sm_marker marker;struct stat st;int bad=root<0;
  if(!bad)bad=sm_read(root,&marker)||marker.version!=2||
    marker.fields[0]!=bridge->prepared.root_device||marker.fields[1]!=bridge->prepared.root_inode||
    memcmp(marker.id,bridge->prepared.marker,33);
  if(!bad){v1=sm_validate_namespace(root,bridge->root_path,&marker,-1);bad=v1<0;}
  char base[67],name[37];
  for(size_t i=0;i<32;i++)snprintf(base+i*2,3,"%02x",bridge->prepared.coordination_id[i]);memcpy(base+64,".h",3);
  for(size_t i=0;i<16;i++)snprintf(name+i*2,3,"%02x",bridge->prepared.handoff_id[i]);memcpy(name+32,".rec",5);
  if(!bad){ledger=openat(v1,base,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);bad=ledger<0||sm_dir_private(ledger,&st);}
  if(!bad){fd=openat(ledger,name,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);bad=fd<0;}
  if(!bad)bad=fstat(fd,&st)||st.st_dev!=(dev_t)bridge->record_device||st.st_ino!=(ino_t)bridge->record_inode||
    ps_handoff_read(fd,current)||ps_handoff_named_identity(ledger,fd,name)||
    sm_record_namespace(fd,current->marker,current->root_device,current->root_inode,current->coordination_id,current->handoff_id);
  if(!bad) {
    ps_handoff_record_t comparable=*current;
    comparable.supervisor_pid=comparable.receiver_pid=0;
    comparable.supervisor_start_sec=comparable.supervisor_start_usec=0;
    comparable.receiver_start_sec=comparable.receiver_start_usec=0;
    bad=!ps_handoff_same_registration(&comparable,&bridge->prepared)||
      (current->stage==PS_HANDOFF_PREPARED&&(current->supervisor_pid||current->receiver_pid))||
      (current->stage>=PS_HANDOFF_SUPERVISOR_REGISTERED&&current->supervisor_pid<=0)||
      (current->stage==PS_HANDOFF_SUPERVISOR_REGISTERED&&current->receiver_pid)||
      (current->stage>=PS_HANDOFF_REGISTERED&&current->receiver_pid<=0);
  }
  if(fd>=0)close(fd);if(ledger>=0)close(ledger);if(v1>=0)close(v1);if(root>=0)close(root);
  return bad?-1:0;
}
static int op_incarnation_live(int pid,uint64_t sec,uint64_t usec) {
  if(pid==0)return sec||usec?-1:0;
  if(pid<0||!sec)return -1;
  uint64_t now_sec=0,now_usec=0;int inspected=ps_process_identity(pid,&now_sec,&now_usec);
  return inspected<0?-1:ps_exact_process_alive(inspected,now_sec,now_usec,sec,usec);
}
/* Read-only proof. SETTLED does not shortcut supervisor or receiver inspection. */
static int op_bridge_terminal(op_bridge_record *b,ps_handoff_record_t *r,int owned) {
  if(op_bridge_handoff(b,r))return -1;
  /* Terminal certificate is written only after normal owned exact settlement
     while S is held and the complete operation unit has returned. */
  if(b->terminal)return r->stage==PS_HANDOFF_SETTLED?1:-1;
  char boot[37];if(ps_boot_uuid(boot))return -1;
  if(strcmp(boot,r->boot_uuid))return owned?-1:1;
  int coordinator=op_incarnation_live(r->coordinator_pid,r->coordinator_start_sec,r->coordinator_start_usec);
  int supervisor=op_incarnation_live(r->supervisor_pid,r->supervisor_start_sec,r->supervisor_start_usec);
  int receiver=op_incarnation_live(r->receiver_pid,r->receiver_start_sec,r->receiver_start_usec);
  if(coordinator<0||supervisor<0||receiver<0)return -1;
  if(owned) {
    if(r->coordinator_pid!=getpid()||coordinator!=1||r->stage!=PS_HANDOFF_SETTLED)return -1;
    return supervisor||receiver?0:1;
  }
  return coordinator||supervisor||receiver?0:1;
}
static long long op_bridge_now(void) {
  struct timespec t;if(clock_gettime(CLOCK_MONOTONIC,&t))return -1;
  return (long long)t.tv_sec*1000+t.tv_nsec/1000000;
}
static int op_bridge_scan(ps_operation_gate *g,int prove_terminal) {
  if(op_validate(g))return -1;
  int scan=openat(g->directory_fd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if(scan<0)return -1;DIR *stream=fdopendir(scan);if(!stream){close(scan);return -1;}
  long long start=op_bridge_now();int count=0,result=1;struct dirent *entry;
  if(start<0){closedir(stream);return -1;}
  while(1) {
    errno=0;entry=readdir(stream);if(!entry){if(errno)result=-1;break;}
    if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,"..")||!strcmp(entry->d_name,"identity")||
      !strcmp(entry->d_name,"operation.lock")||!strcmp(entry->d_name,"latch.lock")||!strcmp(entry->d_name,"deny"))continue;
    if(!strcmp(entry->d_name,"run.lock")) {
      struct stat run_stat;int run_fd=openat(g->directory_fd,"run.lock",O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
      int valid=run_fd>=0&&op_valid_file(run_fd,&run_stat)&&run_stat.st_dev==g->device;
      if(run_fd>=0)close(run_fd);if(!valid){result=-1;break;}continue;
    }
    if(++count>OP_BRIDGE_LIMIT||op_bridge_now()<start||op_bridge_now()-start>2000){result=-1;break;}
    op_bridge_record b;ps_handoff_record_t r;struct stat st;
    if(op_bridge_read(g,entry->d_name,&b,&st)){result=-1;break;}
    if(!prove_terminal&&count>=OP_BRIDGE_LIMIT){result=-1;break;}
    if(prove_terminal){int terminal=op_bridge_terminal(&b,&r,0);if(terminal!=1){result=terminal;break;}}
  }
  closedir(stream);return result;
}
static int op_scan_bridges(ps_operation_gate *g) {return op_bridge_scan(g,1);}
static int op_create_bridge(ps_operation_gate *g,ps_handoff_t *handoff) {
  if(!g->held||g->exclusive||strcmp(g->name,"operation.lock")||op_validate(g)||
    ps_validate_handoff_namespace(handoff)||op_bridge_scan(g,0)!=1)return -1;
  struct stat st;ps_handoff_record_t r;
  if(ps_handoff_read(handoff->record_fd,&r)||fstat(handoff->record_fd,&st)||
    r.stage!=PS_HANDOFF_PREPARED||r.supervisor_pid||r.receiver_pid||r.coordinator_pid!=getpid())return -1;
  op_owned_bridge *owned=calloc(1,sizeof(*owned));if(!owned)return -1;
  op_bridge_record b;memset(&b,0,sizeof(b));b.magic=OP_BRIDGE_MAGIC;
  b.control_device=g->device;b.control_inode=g->directory_inode;b.control_lock_inode=g->lock_inode;
  b.record_device=st.st_dev;b.record_inode=st.st_ino;b.prepared=r;
  strcpy(b.deployment,g->deployment);strcpy(b.root_path,handoff->root_path);
  unsigned char id[16];arc4random_buf(id,16);
  for(int i=0;i<16;i++)snprintf(b.launch_id+i*2,3,"%02x",id[i]);
  snprintf(owned->name,sizeof(owned->name),"bridge.%s",b.launch_id);op_bridge_checksum(&b);
  int fd=openat(g->directory_fd,owned->name,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  if(fd<0){free(owned);return -1;}
  int bad=pwrite(fd,&b,sizeof(b),0)!=(ssize_t)sizeof(b)||full_sync_file_fd(fd)||sync_directory_fd(g->directory_fd);
  close(fd);owned->next=g->bridges;g->bridges=owned;
  /* Partial records remain as protection; never launch after a durability error. */
  return bad?-1:0;
}
static int op_finish_owned(ps_operation_gate *g) {
  if(!g->bridges)return 0;
  if(op_validate(g))return -1;
  while(g->bridges) {
    op_owned_bridge *owned=g->bridges;op_bridge_record b;ps_handoff_record_t r;struct stat st,named;
    if(op_bridge_read(g,owned->name,&b,&st)||op_bridge_terminal(&b,&r,1)!=1||
      fstatat(g->directory_fd,owned->name,&named,AT_SYMLINK_NOFOLLOW)||!sm_same_file(&st,&named))return -1;
    int fd=openat(g->directory_fd,owned->name,O_RDWR|O_NOFOLLOW|O_CLOEXEC);
    struct stat opened;
    if(fd<0)return -1;
    if(!op_valid_file(fd,&opened)||!sm_same_file(&st,&opened)){close(fd);return -1;}
    b.terminal=1;op_bridge_checksum(&b);
    int bad=pwrite(fd,&b,sizeof(b),0)!=(ssize_t)sizeof(b)||full_sync_file_fd(fd)||sync_directory_fd(g->directory_fd);
    close(fd);if(bad)return -1;
    /* Keep the durable certificate until restricted DRAINED_X recovery. */
    g->bridges=owned->next;free(owned);
  }
  return 0;
}
/* Restricted recovery only after the complete private RAW_X proof has succeeded. */
static int op_recover_bridge_index(ps_operation_gate *g) {
  if(!g->held||!g->exclusive||!g->drained||strcmp(g->name,"operation.lock")||op_scan_bridges(g)!=1)return -1;
  int scan=openat(g->directory_fd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if(scan<0)return -1;DIR *stream=fdopendir(scan);if(!stream){close(scan);return -1;}
  char (*names)[40]=calloc(OP_BRIDGE_LIMIT,sizeof(*names));if(!names){closedir(stream);return -1;}
  size_t count=0;int bad=0;struct dirent *entry;
  long long start=op_bridge_now();
  while(1) {
    errno=0;entry=readdir(stream);if(!entry){if(errno)bad=1;break;}
    if(!op_bridge_name(entry->d_name))continue;
    if(count>=OP_BRIDGE_LIMIT||op_bridge_now()-start>2000){bad=1;break;}
    strcpy(names[count++],entry->d_name);
  }
  closedir(stream);
  /* No media ledger mutation and no old content-lock acquisition here. */
  for(size_t i=0;!bad&&i<count;i++) {
    op_bridge_record b;ps_handoff_record_t r;struct stat st,named;
    if(op_bridge_read(g,names[i],&b,&st)||op_bridge_terminal(&b,&r,0)!=1||
      fstatat(g->directory_fd,names[i],&named,AT_SYMLINK_NOFOLLOW)||!sm_same_file(&st,&named)||
      unlinkat(g->directory_fd,names[i],0)||sync_directory_fd(g->directory_fd))bad=1;
  }
  free(names);return bad?-1:0;
}

#endif
