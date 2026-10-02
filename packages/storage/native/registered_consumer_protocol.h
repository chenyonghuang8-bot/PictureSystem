#ifndef PS_REGISTERED_CONSUMER_PROTOCOL_H
#define PS_REGISTERED_CONSUMER_PROTOCOL_H
#include <CommonCrypto/CommonDigest.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include "storage_marker.h"

#define PS_HANDOFF_MAGIC UINT64_C(0x48414e444f464631)
#define PS_HANDOFF_FORMAT UINT32_C(3)
#define PS_HANDOFF_PREPARED UINT32_C(1)
#define PS_HANDOFF_SUPERVISOR_REGISTERED UINT32_C(2)
#define PS_HANDOFF_REGISTERED UINT32_C(3)
#define PS_HANDOFF_SETTLED UINT32_C(4)
typedef struct {
  uint64_t magic;
  uint32_t format, stage;
  unsigned char handoff_id[16];
  uint64_t root_device, root_inode;
  char marker[33];
  unsigned char coordination_id[CC_SHA256_DIGEST_LENGTH];
  char boot_uuid[37];
  int32_t coordinator_pid;
  uint64_t coordinator_start_sec, coordinator_start_usec;
  int32_t supervisor_pid;
  uint64_t supervisor_start_sec, supervisor_start_usec;
  int32_t receiver_pid;
  uint64_t receiver_start_sec, receiver_start_usec;
  uint32_t input_type;
  unsigned char asset_binding[CC_SHA256_DIGEST_LENGTH];
  unsigned char checksum[CC_SHA256_DIGEST_LENGTH];
} ps_handoff_record_t;

enum {P7_INIT=1, P7_ARMED=2, P7_MEDIA=3, P7_SOURCE_RELEASED=4};
typedef struct {
  uint32_t type;
  unsigned char handoff_id[16], coordination_id[32];
  uint64_t device, inode, size;
} p7_message;
typedef struct {
  int record_fd, coordinator_fd, consumer_fd;
  ps_handoff_record_t record;
  int source_released;
} p7_supervisor;

#define P7_FN static __attribute__((unused))
P7_FN int p7_identity(pid_t pid,uint64_t *sec,uint64_t *usec) {
  struct proc_bsdinfo info; memset(&info,0,sizeof(info)); errno=0;
  int n=proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info));
  if(n==(int)sizeof(info)&&info.pbi_pid==(uint32_t)pid&&info.pbi_start_tvsec) {
    *sec=info.pbi_start_tvsec;*usec=info.pbi_start_tvusec;return 1;
  }
  return n==0&&errno==ESRCH?0:-1;
}
P7_FN int p7_boot(char out[37]) {
  size_t n=37;return sysctlbyname("kern.bootsessionuuid",out,&n,NULL,0)==0&&n==37&&out[36]==0?0:-1;
}
P7_FN void p7_checksum(ps_handoff_record_t *r) {
  memset(r->checksum,0,32);CC_SHA256(r,(CC_LONG)sizeof(*r),r->checksum);
}
P7_FN int p7_record_read(int fd,ps_handoff_record_t *r) {
  struct stat st;unsigned char saved[32];
  if(fstat(fd,&st)||!S_ISREG(st.st_mode)||st.st_uid!=geteuid()||st.st_nlink!=1||
     (st.st_mode&07777)!=0600||st.st_size!=(off_t)sizeof(*r)||
     pread(fd,r,sizeof(*r),0)!=(ssize_t)sizeof(*r))return -1;
  memcpy(saved,r->checksum,32);p7_checksum(r);
  int valid=memcmp(saved,r->checksum,32)==0&&r->magic==PS_HANDOFF_MAGIC&&
    r->format==PS_HANDOFF_FORMAT&&r->stage>=1&&r->stage<=4;
  memcpy(r->checksum,saved,32);
  if(valid&&sm_record_namespace(fd,r->marker,r->root_device,r->root_inode,r->coordination_id,r->handoff_id))valid=0;
  return valid?0:-1;
}
P7_FN int p7_record_write(int fd,ps_handoff_record_t *r) {
  if(sm_record_namespace(fd,r->marker,r->root_device,r->root_inode,r->coordination_id,r->handoff_id))return -1;
  p7_checksum(r);
  return pwrite(fd,r,sizeof(*r),0)==(ssize_t)sizeof(*r)&&fcntl(fd,F_FULLFSYNC)==0?0:-1;
}
P7_FN int p7_same(const ps_handoff_record_t *a,const ps_handoff_record_t *b) {
  return a->root_device==b->root_device&&a->root_inode==b->root_inode&&
    !memcmp(a->marker,b->marker,33)&&!memcmp(a->handoff_id,b->handoff_id,16)&&
    !memcmp(a->coordination_id,b->coordination_id,32)&&!memcmp(a->boot_uuid,b->boot_uuid,37)&&
    a->coordinator_pid==b->coordinator_pid&&a->coordinator_start_sec==b->coordinator_start_sec&&
    a->coordinator_start_usec==b->coordinator_start_usec&&a->supervisor_pid==b->supervisor_pid&&
    a->supervisor_start_sec==b->supervisor_start_sec&&a->supervisor_start_usec==b->supervisor_start_usec&&
    a->input_type==b->input_type&&!memcmp(a->asset_binding,b->asset_binding,32);
}
P7_FN int p7_send(int socket,const ps_handoff_record_t *r,uint32_t type,int fd) {
  p7_message m;memset(&m,0,sizeof(m));m.type=type;
  memcpy(m.handoff_id,r->handoff_id,16);memcpy(m.coordination_id,r->coordination_id,32);
  if(type==P7_MEDIA) {
    struct stat st;if(fd<0||fstat(fd,&st)||!S_ISREG(st.st_mode)||
      (fcntl(fd,F_GETFL)&O_ACCMODE)!=O_RDONLY)return -1;
    m.device=(uint64_t)st.st_dev;m.inode=(uint64_t)st.st_ino;m.size=(uint64_t)st.st_size;
  }
  struct iovec iov={&m,sizeof(m)};struct msghdr msg;memset(&msg,0,sizeof(msg));
  msg.msg_iov=&iov;msg.msg_iovlen=1;
  union{struct cmsghdr align;char bytes[CMSG_SPACE(sizeof(int))];} c;
  if(fd>=0){memset(&c,0,sizeof(c));msg.msg_control=c.bytes;msg.msg_controllen=sizeof(c.bytes);
    struct cmsghdr *h=CMSG_FIRSTHDR(&msg);h->cmsg_level=SOL_SOCKET;h->cmsg_type=SCM_RIGHTS;
    h->cmsg_len=CMSG_LEN(sizeof(int));memcpy(CMSG_DATA(h),&fd,sizeof(fd));}
  return sendmsg(socket,&msg,0)==(ssize_t)sizeof(m)?0:-1;
}
P7_FN int p7_receive(int socket,const ps_handoff_record_t *r,uint32_t type,int want_fd,int *received,int timeout) {
  *received=-1;struct pollfd ready={socket,POLLIN,0};
  int polled;do{polled=poll(&ready,1,timeout);}while(polled<0&&errno==EINTR);
  if(polled!=1||!(ready.revents&POLLIN))return -1;
  p7_message m;struct iovec iov={&m,sizeof(m)};struct msghdr msg;memset(&msg,0,sizeof(msg));
  union{struct cmsghdr align;char bytes[CMSG_SPACE(16*sizeof(int))];} c;memset(&c,0,sizeof(c));
  msg.msg_iov=&iov;msg.msg_iovlen=1;msg.msg_control=c.bytes;msg.msg_controllen=sizeof(c.bytes);
  ssize_t n=recvmsg(socket,&msg,0);int count=0,bad=0;
  for(struct cmsghdr *h=CMSG_FIRSTHDR(&msg);h;h=CMSG_NXTHDR(&msg,h)) {
    if(h->cmsg_level!=SOL_SOCKET||h->cmsg_type!=SCM_RIGHTS||h->cmsg_len<CMSG_LEN(0)){bad=1;continue;}
    size_t bytes=h->cmsg_len-CMSG_LEN(0);if(bytes%sizeof(int))bad=1;
    for(size_t i=0;i<bytes/sizeof(int);i++){int fd;memcpy(&fd,CMSG_DATA(h)+i*sizeof(int),sizeof(int));
      if(count++==0)*received=fd;else close(fd);}
  }
  if(n!=(ssize_t)sizeof(m)||(msg.msg_flags&(MSG_TRUNC|MSG_CTRUNC))||bad||count!=want_fd||
    m.type!=type||(r&&(memcmp(m.handoff_id,r->handoff_id,16)!=0||memcmp(m.coordination_id,r->coordination_id,32)!=0)))goto fail;
  if(*received>=0&&fcntl(*received,F_SETFD,FD_CLOEXEC))goto fail;
  if(type==P7_MEDIA){struct stat st;if(*received<0||fstat(*received,&st)||!S_ISREG(st.st_mode)||
    (fcntl(*received,F_GETFL)&O_ACCMODE)!=O_RDONLY||(uint64_t)st.st_dev!=m.device||
    (uint64_t)st.st_ino!=m.inode||(uint64_t)st.st_size!=m.size)goto fail;}
  return 0;
fail:if(*received>=0)close(*received);*received=-1;return -1;
}
P7_FN int p7_is_socket(int fd){struct stat s;return fstat(fd,&s)==0&&S_ISSOCK(s.st_mode);}
P7_FN int p7_supervisor_init(p7_supervisor *s,int control) {
  memset(s,0,sizeof(*s));s->record_fd=s->consumer_fd=-1;s->coordinator_fd=control;
  struct pollfd available={control,POLLIN,0};
  if(poll(&available,1,30000)!=1||!(available.revents&POLLIN))return -1;
  p7_message init;
  if(recv(control,&init,sizeof(init),MSG_PEEK)!=(ssize_t)sizeof(init)||
    p7_receive(control,NULL,P7_INIT,1,&s->record_fd,30000)||p7_record_read(s->record_fd,&s->record)||
    memcmp(init.handoff_id,s->record.handoff_id,16)||memcmp(init.coordination_id,s->record.coordination_id,32))return -1;
  uint64_t sec=0,usec=0;char boot[37];
  return s->record.stage==PS_HANDOFF_SUPERVISOR_REGISTERED&&s->record.supervisor_pid==getpid()&&
    p7_identity(getpid(),&sec,&usec)==1&&sec==s->record.supervisor_start_sec&&
    usec==s->record.supervisor_start_usec&&p7_boot(boot)==0&&!strcmp(boot,s->record.boot_uuid)?0:-1;
}
P7_FN int p7_supervisor_deliver(p7_supervisor *s,pid_t child) {
  ps_handoff_record_t fresh;uint64_t sec=0,usec=0;
  if(p7_record_read(s->record_fd,&fresh)||!p7_same(&fresh,&s->record)||
    fresh.stage!=PS_HANDOFF_SUPERVISOR_REGISTERED||p7_identity(child,&sec,&usec)!=1)return -1;
  fresh.receiver_pid=child;fresh.receiver_start_sec=sec;fresh.receiver_start_usec=usec;
  fresh.stage=PS_HANDOFF_REGISTERED;
  if(p7_record_write(s->record_fd,&fresh))return -1;s->record=fresh;
  if(sm_record_namespace(s->record_fd,fresh.marker,fresh.root_device,fresh.root_inode,fresh.coordination_id,fresh.handoff_id)||p7_send(s->coordinator_fd,&fresh,P7_ARMED,-1))return -1;
  int media=-1,unused=-1;
  if(p7_receive(s->coordinator_fd,&fresh,P7_MEDIA,1,&media,30000))return -1;
  if(p7_receive(s->coordinator_fd,&fresh,P7_SOURCE_RELEASED,0,&unused,30000)){close(media);return -1;}
  if(sm_record_namespace(s->record_fd,fresh.marker,fresh.root_device,fresh.root_inode,fresh.coordination_id,fresh.handoff_id)){close(media);return -1;}
  s->source_released=1;
  int result=p7_send(s->consumer_fd,&fresh,P7_MEDIA,media);close(media);
  close(s->consumer_fd);s->consumer_fd=-1;close(s->coordinator_fd);s->coordinator_fd=-1;
  return result;
}
P7_FN int p7_supervisor_settle(p7_supervisor *s,int exact_reaped) {
  ps_handoff_record_t fresh;
  if(!exact_reaped||!s->source_released||s->consumer_fd>=0||s->coordinator_fd>=0||
    p7_record_read(s->record_fd,&fresh)||!p7_same(&fresh,&s->record)||
    fresh.receiver_pid!=s->record.receiver_pid||fresh.receiver_start_sec!=s->record.receiver_start_sec||
    fresh.receiver_start_usec!=s->record.receiver_start_usec||fresh.stage!=PS_HANDOFF_REGISTERED)return -1;
#ifdef PS_P7_TEST_BARRIERS
  if(getenv("PS_P7_HOLD_SETTLEMENT")) {
    char release;
    if(write(4,"REAPED\n",7)!=7||read(4,&release,1)!=1||release!='S')return -1;
  }
#endif
  fresh.stage=PS_HANDOFF_SETTLED;return p7_record_write(s->record_fd,&fresh);
}
P7_FN int p7_bootstrap_receive(int fd) {
  int media=-1;if(p7_receive(fd,NULL,P7_MEDIA,1,&media,30000))return -1;
  close(fd);if(dup2(media,3)!=3){close(media);return -1;}if(media!=3)close(media);
  return 0;
}
#endif
