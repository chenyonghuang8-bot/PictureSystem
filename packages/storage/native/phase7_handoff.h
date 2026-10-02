#ifndef PS_PHASE7_HANDOFF_H
#define PS_PHASE7_HANDOFF_H
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <sys/un.h>

#include "registered_consumer_protocol.h"

typedef struct {
  uint64_t magic;
  int directory_fd;
  int record_fd;
  char name[37];
  ps_handoff_record_t record;
  // Immutable trusted K copied from the acquired native read guard.
  char family[21];
  char sha[65];
  char byte_size[21];
} ps_handoff_t;

static int ps_handoff_same_registration(const ps_handoff_record_t *a,
                                        const ps_handoff_record_t *b) {
  return memcmp(a->handoff_id,b->handoff_id,16)==0 &&
      a->root_device==b->root_device && a->root_inode==b->root_inode &&
      memcmp(a->marker,b->marker,sizeof(a->marker))==0 &&
      memcmp(a->coordination_id,b->coordination_id,sizeof(a->coordination_id))==0 &&
      memcmp(a->boot_uuid,b->boot_uuid,sizeof(a->boot_uuid))==0 &&
      a->coordinator_pid==b->coordinator_pid &&
      a->coordinator_start_sec==b->coordinator_start_sec &&
      a->coordinator_start_usec==b->coordinator_start_usec &&
      a->input_type==b->input_type &&
      memcmp(a->asset_binding,b->asset_binding,32)==0 &&
      a->supervisor_pid==b->supervisor_pid &&
      a->supervisor_start_sec==b->supervisor_start_sec &&
      a->supervisor_start_usec==b->supervisor_start_usec &&
      a->receiver_pid==b->receiver_pid &&
      a->receiver_start_sec==b->receiver_start_sec &&
      a->receiver_start_usec==b->receiver_start_usec;
}

static int ps_boot_uuid(char value[37]) {
  size_t length = 37;
  if (sysctlbyname("kern.bootsessionuuid",value,&length,NULL,0) != 0 ||
      length != 37 || value[36] != '\0') return -1;
  for (size_t i=0;i<36;i++) {
    char c=value[i];
    if (!((c>='0'&&c<='9')||(c>='A'&&c<='F')||c=='-')) return -1;
  }
  return 0;
}

// Returns 1 for the exact live identity, 0 for proven absent/reused, -1
// when process inspection cannot distinguish absence from permission failure.
static int ps_process_identity(int pid,uint64_t *sec,uint64_t *usec) {
  struct proc_bsdinfo info;
  memset(&info,0,sizeof(info)); errno=0;
  int count=proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info));
  if (count==(int)sizeof(info)) {
    if (info.pbi_pid!=(uint32_t)pid || info.pbi_start_tvsec==0) return -1;
    *sec=info.pbi_start_tvsec; *usec=info.pbi_start_tvusec; return 1;
  }
  if (count==0 && errno==ESRCH) return 0;
  return -1;
}
static int ps_exact_process_alive(int inspected,uint64_t current_sec,
    uint64_t current_usec,uint64_t recorded_sec,uint64_t recorded_usec) {
  return inspected==1 && current_sec==recorded_sec &&
      current_usec==recorded_usec;
}

static void ps_handoff_checksum(ps_handoff_record_t *record) {
  memset(record->checksum,0,sizeof(record->checksum));
  CC_SHA256(record,(CC_LONG)sizeof(*record),record->checksum);
}
static int ps_handoff_valid(ps_handoff_record_t *record) {
  unsigned char saved[CC_SHA256_DIGEST_LENGTH];
  memcpy(saved,record->checksum,sizeof(saved));
  ps_handoff_checksum(record);
  int valid=memcmp(saved,record->checksum,sizeof(saved))==0 &&
      record->magic==PS_HANDOFF_MAGIC && record->format==PS_HANDOFF_FORMAT &&
      record->stage>=PS_HANDOFF_PREPARED && record->stage<=PS_HANDOFF_SETTLED;
  memcpy(record->checksum,saved,sizeof(saved));
  return valid;
}
static int ps_handoff_read(int fd,ps_handoff_record_t *record) {
  struct stat status;
  if (fstat(fd,&status)!=0 || !S_ISREG(status.st_mode) ||
      status.st_uid!=geteuid() || status.st_gid!=getegid() ||
      status.st_nlink!=1 || (status.st_mode&07777)!=0600 ||
      status.st_size!=(off_t)sizeof(*record) ||
      validate_no_extended_acl(fd)!=0 ||
      pread(fd,record,sizeof(*record),0)!=(ssize_t)sizeof(*record) ||
      !ps_handoff_valid(record)) {errno=EPERM;return -1;}
  return 0;
}
static int ps_handoff_named_identity(int dir,int fd,const char *name) {
  struct stat open_status,named_status;
  if (fstat(fd,&open_status)!=0 ||
      fstatat(dir,name,&named_status,AT_SYMLINK_NOFOLLOW)!=0 ||
      !S_ISREG(named_status.st_mode) ||
      open_status.st_dev!=named_status.st_dev ||
      open_status.st_ino!=named_status.st_ino ||
      open_status.st_nlink!=1 || named_status.st_nlink!=1) {
    errno=EPERM;return -1;
  }
  return 0;
}
static int ps_handoff_write(int fd,ps_handoff_record_t *record) {
  ps_handoff_checksum(record);
  if (pwrite(fd,record,sizeof(*record),0)!=(ssize_t)sizeof(*record) ||
      full_sync_file_fd(fd)!=0) return -1;
  return 0;
}
static int ps_handoff_directory(ps_coord_t *coord,int create) {
  char name[67]; memcpy(name,coord->basename,64); memcpy(name+64,".h",3);
  int fd=secure_open_child_directory(coord->directory_fd,name,create,1);
  if (fd<0) return -1;
  struct stat status;
  if (fstat(fd,&status)!=0 || status.st_dev!=coord->root_device ||
      status.st_uid!=geteuid() || (status.st_mode&07777)!=0700) {
    close(fd);errno=EPERM;return -1;
  }
  return fd;
}
static void ps_handoff_finalize(napi_env env,void *data,void *hint) {
  (void)env;(void)hint; ps_handoff_t *handoff=data;
  if (!handoff) return;
  if (handoff->record_fd>=0) close(handoff->record_fd);
  if (handoff->directory_fd>=0) close(handoff->directory_fd);
  handoff->magic=0;free(handoff);
}
static ps_handoff_t *ps_handoff_get(napi_env env,napi_value value) {
  ps_handoff_t *handoff=NULL;
  if (napi_get_value_external(env,value,(void **)&handoff)!=napi_ok ||
      handoff==NULL || handoff->magic!=PS_HANDOFF_MAGIC || handoff->record_fd<0) {
    throw_code(env,"HANDOFF_CLOSED","Handoff record is closed.");return NULL;
  }
  return handoff;
}
static ps_handoff_t *ps_allocate_handoff(napi_env env,ps_coord_t *coord) {
  if (coord->basename[65]!='R' || !coord->locked) {
    throw_code(env,"HANDOFF_READ_GUARD_REQUIRED","Hold R before handoff registration.");return NULL;
  }
  char boot[37];uint64_t sec=0,usec=0;
  if (ps_boot_uuid(boot)!=0 || ps_process_identity(getpid(),&sec,&usec)!=1) {
    throw_code(env,"HANDOFF_PROCESS_ID_UNAVAILABLE","Cannot identify this process.");return NULL;
  }
  int dir=ps_handoff_directory(coord,1);
  if (dir<0) {throw_errno(env,"open handoff ledger");return NULL;}
  ps_handoff_t *handoff=calloc(1,sizeof(*handoff));
  if (!handoff) {close(dir);throw_code(env,"STORAGE_NATIVE_ERROR","Handoff allocation failed.");return NULL;}
  handoff->magic=PS_HANDOFF_MAGIC;handoff->directory_fd=dir;handoff->record_fd=-1;
  strcpy(handoff->family,coord->family);strcpy(handoff->sha,coord->sha);
  strcpy(handoff->byte_size,coord->byte_size);
  ps_handoff_record_t *record=&handoff->record;
  record->magic=PS_HANDOFF_MAGIC;record->format=PS_HANDOFF_FORMAT;
  record->stage=PS_HANDOFF_PREPARED;
  arc4random_buf(record->handoff_id,sizeof(record->handoff_id));
  record->root_device=(uint64_t)coord->root_device;
  record->root_inode=(uint64_t)coord->root_inode;
  strcpy(record->marker,coord->marker);strcpy(record->boot_uuid,boot);
  memcpy(record->coordination_id,coord->coordination_id,sizeof(record->coordination_id));
  record->coordinator_pid=getpid();record->coordinator_start_sec=sec;
  record->coordinator_start_usec=usec;record->input_type=1;
  record->supervisor_pid=getpid();record->supervisor_start_sec=sec;
  record->supervisor_start_usec=usec;
  for(size_t i=0;i<sizeof(record->handoff_id);i++)
    (void)snprintf(handoff->name+i*2,3,"%02x",record->handoff_id[i]);
  memcpy(handoff->name+32,".rec",5);
  int fd=openat(dir,handoff->name,O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  if (fd<0) {ps_handoff_finalize(env,handoff,NULL);throw_errno(env,"create handoff record");return NULL;}
  handoff->record_fd=fd;
  if (ps_handoff_write(fd,record)!=0 || sync_directory_fd(dir)!=0) {
    // Intentionally leave a corrupt/partial record to fail R-X closed.
    ps_handoff_finalize(env,handoff,NULL);throw_errno(env,"durable handoff registration");return NULL;
  }
  return handoff;
}
static napi_value ps_create_handoff(napi_env env,napi_callback_info info) {
  napi_value arg;size_t argc=1;napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  ps_coord_t *coord=ps_coord_get(env,arg);if(!coord)return NULL;
  ps_handoff_t *handoff=ps_allocate_handoff(env,coord);if(!handoff)return NULL;
  napi_value external;napi_create_external(env,handoff,ps_handoff_finalize,NULL,&external);return external;
}
static napi_value ps_register_handoff_receiver(napi_env env,napi_callback_info info) {
  napi_value args[2];size_t argc=2;napi_get_cb_info(env,info,&argc,args,NULL,NULL);
  ps_handoff_t *handoff=ps_handoff_get(env,args[0]);if (!handoff) return NULL;
  int32_t pid=0;uint64_t sec=0,usec=0;
  ps_handoff_record_t current;
  if (argc!=2 || napi_get_value_int32(env,args[1],&pid)!=napi_ok || pid<=0 ||
      handoff->record.stage!=PS_HANDOFF_PREPARED ||
      ps_process_identity(pid,&sec,&usec)!=1 ||
      ps_handoff_read(handoff->record_fd,&current)!=0 ||
      current.stage!=PS_HANDOFF_PREPARED ||
      !ps_handoff_same_registration(&current,&handoff->record) ||
      ps_handoff_named_identity(handoff->directory_fd,handoff->record_fd,
                                handoff->name)!=0) {
    throw_code(env,"HANDOFF_RECEIVER_INVALID","Receiver identity unavailable.");return NULL;
  }
  current.receiver_pid=pid;
  current.receiver_start_sec=sec;
  current.receiver_start_usec=usec;
  current.stage=PS_HANDOFF_REGISTERED;
  if (ps_handoff_write(handoff->record_fd,&current)!=0) {
    throw_errno(env,"register handoff receiver");return NULL;
  }
  handoff->record=current;
  return undefined_value(env);
}
static napi_value ps_handoff_registered(napi_env env,napi_callback_info info) {
  napi_value arg;size_t argc=1;napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  ps_handoff_t *handoff=ps_handoff_get(env,arg);if (!handoff) return NULL;
  ps_handoff_record_t current;
  if (ps_handoff_read(handoff->record_fd,&current)!=0 ||
      ps_handoff_named_identity(handoff->directory_fd,handoff->record_fd,
                                handoff->name)!=0 ||
      current.stage!=PS_HANDOFF_REGISTERED ||
      !ps_handoff_same_registration(&current,&handoff->record)) {
    throw_code(env,"HANDOFF_NOT_REGISTERED","Receiver must be registered before FD transfer.");return NULL;
  }
  napi_value yes;napi_get_boolean(env,true,&yes);return yes;
}
static napi_value ps_send_registered_original(napi_env env,napi_callback_info info) {
  napi_value args[3];size_t argc=3;
  napi_get_cb_info(env,info,&argc,args,NULL,NULL);
  int32_t socket_fd=-1;
  if (argc!=3 || napi_get_value_int32(env,args[2],&socket_fd)!=napi_ok || socket_fd<0) {
    throw_code(env,"HANDOFF_INVALID_ARGUMENT","Registered handoff, original and socket are required.");return NULL;
  }
  ps_handoff_t *handoff=ps_handoff_get(env,args[0]);if (!handoff) return NULL;
  original_handle_t *original=get_original_handle(env,args[1]);if (!original) return NULL;
  ps_handoff_record_t current;
  char boot[37],marker[33];uint64_t sec=0,usec=0;
  int root=open_absolute_directory(original->root_path,0);
  pid_t peer_pid=0;socklen_t peer_length=sizeof(peer_pid);
  struct stat root_status;
  int valid=root>=0 && fstat(root,&root_status)==0 &&
      read_marker(root,marker,sizeof(marker),0)==0 &&
      ps_handoff_read(handoff->record_fd,&current)==0 &&
      ps_handoff_named_identity(handoff->directory_fd,handoff->record_fd,
                                handoff->name)==0 &&
      current.stage==PS_HANDOFF_REGISTERED &&
      ps_handoff_same_registration(&current,&handoff->record) &&
      current.root_device==(uint64_t)root_status.st_dev &&
      current.root_inode==(uint64_t)root_status.st_ino &&
      strcmp(current.marker,marker)==0 &&
      ps_boot_uuid(boot)==0 && strcmp(current.boot_uuid,boot)==0 &&
      current.supervisor_pid==getpid() &&
      ps_process_identity(getpid(),&sec,&usec)==1 &&
      current.supervisor_start_sec==sec && current.supervisor_start_usec==usec &&
      ps_process_identity(current.receiver_pid,&sec,&usec)==1 &&
      current.receiver_start_sec==sec && current.receiver_start_usec==usec;
  if (valid) valid=getsockopt(socket_fd,SOL_LOCAL,LOCAL_PEERPID,&peer_pid,&peer_length)==0 &&
      peer_length==sizeof(peer_pid) && peer_pid==current.receiver_pid;
  if (root>=0) close(root);
  if (!valid) {
    throw_code(env,"HANDOFF_NOT_REGISTERED","Durable receiver registration required before FD transfer.");return NULL;
  }
  // Both operands come from validated native capabilities. Caller strings
  // cannot relabel an Original or move a registered handoff to another K.
  if (current.root_device!=(uint64_t)original->device ||
      current.root_inode!=(uint64_t)original->root_inode ||
      strcmp(current.marker,original->marker)!=0 ||
      strcmp(handoff->family,original->family)!=0 ||
      strcmp(handoff->sha,original->sha)!=0 ||
      strcmp(handoff->byte_size,original->byte_size)!=0) {
    throw_code(env,"HANDOFF_CONTENT_MISMATCH","Original does not match the registered content identity.");return NULL;
  }
  struct stat current_file,named;
  if (fstat(original->file_fd,&current_file)!=0 ||
      fstatat(original->parent_fd,original->base,&named,AT_SYMLINK_NOFOLLOW)!=0 ||
      current_file.st_dev!=original->device || current_file.st_ino!=original->inode ||
      current_file.st_size!=original->size ||
      current_file.st_mtimespec.tv_sec!=original->mtime.tv_sec ||
      current_file.st_mtimespec.tv_nsec!=original->mtime.tv_nsec ||
      named.st_dev!=original->device || named.st_ino!=original->inode ||
      named.st_nlink!=1 || (named.st_mode&0777)!=0400 ||
      lseek(original->file_fd,0,SEEK_SET)!=0) {
    throw_code(env,"HANDOFF_ORIGINAL_CHANGED","Original identity changed before handoff.");return NULL;
  }
  char marker_byte='H';
  struct iovec iov={.iov_base=&marker_byte,.iov_len=1};
  union {struct cmsghdr header; char bytes[CMSG_SPACE(sizeof(int))];} ancillary;
  memset(&ancillary,0,sizeof(ancillary));
  struct msghdr message={0};
  message.msg_iov=&iov;message.msg_iovlen=1;
  message.msg_control=ancillary.bytes;message.msg_controllen=sizeof(ancillary.bytes);
  struct cmsghdr *control=CMSG_FIRSTHDR(&message);
  control->cmsg_level=SOL_SOCKET;control->cmsg_type=SCM_RIGHTS;
  control->cmsg_len=CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(control),&original->file_fd,sizeof(int));
  if (sendmsg(socket_fd,&message,MSG_DONTWAIT)!=1) {
    throw_errno(env,"send registered original");return NULL;
  }
  int failure=0;
  if (close(original->file_fd)!=0) failure=errno;
  if (close(original->parent_fd)!=0 && failure==0) failure=errno;
  original->file_fd=-1;original->parent_fd=-1;original->consumed=1;
  if (failure!=0) {
    errno=failure;throw_errno(env,"close handed-off original");return NULL;
  }
  return undefined_value(env);
}
static napi_value ps_settle_handoff(napi_env env,napi_callback_info info) {
  napi_value arg;size_t argc=1;napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  ps_handoff_t *handoff=ps_handoff_get(env,arg);if (!handoff) return NULL;
  ps_handoff_record_t current;
  if (ps_handoff_read(handoff->record_fd,&current)!=0 ||
      ps_handoff_named_identity(handoff->directory_fd,handoff->record_fd,
                                handoff->name)!=0 ||
      current.stage!=PS_HANDOFF_REGISTERED ||
      !ps_handoff_same_registration(&current,&handoff->record) ||
      current.supervisor_pid!=getpid()) {
    throw_code(env,"HANDOFF_SETTLEMENT_DENIED","Invalid handoff settlement.");return NULL;
  }
  uint64_t sec=0,usec=0;
  if (ps_process_identity(getpid(),&sec,&usec)!=1 ||
      sec!=current.supervisor_start_sec || usec!=current.supervisor_start_usec) {
    throw_code(env,"HANDOFF_SUPERVISOR_CHANGED","Supervisor identity changed.");return NULL;
  }
  int status=0;
  pid_t waited=waitpid(current.receiver_pid,&status,WNOHANG);
  if (waited!=current.receiver_pid) {
    throw_code(env,"HANDOFF_RECEIVER_UNSETTLED","Exact child has not been reaped.");return NULL;
  }
  current.stage=PS_HANDOFF_SETTLED;
  if (ps_handoff_write(handoff->record_fd,&current)!=0) {
    throw_errno(env,"settle handoff");return NULL;
  }
  handoff->record=current;
  return undefined_value(env);
}
static napi_value ps_close_handoff(napi_env env,napi_callback_info info) {
  napi_value arg;size_t argc=1;napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  ps_handoff_t *handoff=ps_handoff_get(env,arg);if (!handoff) return NULL;
  if (close(handoff->record_fd)!=0) {throw_errno(env,"close handoff record");return NULL;}
  handoff->record_fd=-1;
  close(handoff->directory_fd);handoff->directory_fd=-1;
  return undefined_value(env);
}
static int ps_handoff_record_status(ps_handoff_record_t *record,
                                    ps_coord_t *coord,const char *boot) {
  if (record->root_device!=(uint64_t)coord->root_device ||
      record->root_inode!=(uint64_t)coord->root_inode ||
      strcmp(record->marker,coord->marker)!=0 ||
      memcmp(record->coordination_id,coord->coordination_id,sizeof(record->coordination_id))!=0) return -1;
  if (record->stage==PS_HANDOFF_SETTLED) return 1;
  if (strcmp(record->boot_uuid,boot)!=0) return 2;
  uint64_t sec=0,usec=0;
  int coordinator=ps_process_identity(record->coordinator_pid,&sec,&usec);
  if (coordinator<0) return -1;
  int coordinator_live=ps_exact_process_alive(coordinator,sec,usec,
      record->coordinator_start_sec,record->coordinator_start_usec);
  int supervisor=record->supervisor_pid>0?ps_process_identity(record->supervisor_pid,&sec,&usec):0;
  if (supervisor<0) return -1;
  int supervisor_live=ps_exact_process_alive(supervisor,sec,usec,
      record->supervisor_start_sec,record->supervisor_start_usec);
  int receiver_live=0;
  if (record->stage==PS_HANDOFF_REGISTERED) {
    int receiver=ps_process_identity(record->receiver_pid,&sec,&usec);
    if (receiver<0) return -1;
    receiver_live=ps_exact_process_alive(receiver,sec,usec,
        record->receiver_start_sec,record->receiver_start_usec);
  }
  return coordinator_live||supervisor_live||receiver_live?0:2;
}
static int ps_handoff_admit_exclusive(ps_coord_t *coord) {
  int dir=ps_handoff_directory(coord,0);
  if (dir<0) return errno==ENOENT?1:-1;
  char boot[37];if (ps_boot_uuid(boot)!=0) {close(dir);return -1;}
  int scan_fd=dup(dir);
  if (scan_fd<0) {close(dir);return -1;}
  DIR *stream=fdopendir(scan_fd);
  if (!stream) {close(scan_fd);close(dir);return -1;}
  int result=1;struct dirent *entry;
  errno=0;
  while ((entry=readdir(stream))!=NULL) {
    if (strcmp(entry->d_name,".")==0 || strcmp(entry->d_name,"..")==0) continue;
    if (strlen(entry->d_name)!=36 || strcmp(entry->d_name+32,".rec")!=0) {result=-1;break;}
    char id[33];memcpy(id,entry->d_name,32);id[32]='\0';
    if (ps_coord_hex(id,32)!=0) {result=-1;break;}
    int fd=openat(dir,entry->d_name,O_RDWR|O_NOFOLLOW|O_CLOEXEC);
    if (fd<0) {result=-1;break;}
    ps_handoff_record_t record;
    if (ps_handoff_named_identity(dir,fd,entry->d_name)!=0 ||
        ps_handoff_read(fd,&record)!=0) {close(fd);result=-1;break;}
    char encoded[33];
    for(size_t i=0;i<sizeof(record.handoff_id);i++)
      (void)snprintf(encoded+i*2,3,"%02x",record.handoff_id[i]);
    if (memcmp(encoded,id,32)!=0) {close(fd);result=-1;break;}
    int status=ps_handoff_record_status(&record,coord,boot);
    if (status==2) {
      record.stage=PS_HANDOFF_SETTLED;
      if (ps_handoff_write(fd,&record)!=0) status=-1;
    }
    close(fd);
    if (status!=1 && status!=2) {result=status;break;}
    errno=0;
  }
  if (errno!=0 && result==1) result=-1;
  closedir(stream);close(dir);
  return result;
}

#ifdef PS_STORAGE_TEST_HOOKS
static napi_value ps_test_exact_process_identity(napi_env env,napi_callback_info info) {
  napi_value args[4];size_t argc=4;
  napi_get_cb_info(env,info,&argc,args,NULL,NULL);
  int64_t recorded_sec=0,recorded_usec=0,current_sec=0,current_usec=0;
  if (argc!=4 || napi_get_value_int64(env,args[0],&recorded_sec)!=napi_ok ||
      napi_get_value_int64(env,args[1],&recorded_usec)!=napi_ok ||
      napi_get_value_int64(env,args[2],&current_sec)!=napi_ok ||
      napi_get_value_int64(env,args[3],&current_usec)!=napi_ok ||
      recorded_sec<=0 || recorded_usec<0 || current_sec<=0 || current_usec<0) {
    throw_code(env,"HANDOFF_TEST_IDENTITY_INVALID","Invalid process identity fixture.");return NULL;
  }
  napi_value result;
  napi_get_boolean(env,ps_exact_process_alive(1,(uint64_t)current_sec,
      (uint64_t)current_usec,(uint64_t)recorded_sec,
      (uint64_t)recorded_usec),&result);
  return result;
}
#endif

#endif
