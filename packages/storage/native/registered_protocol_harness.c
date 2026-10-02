#include <stdlib.h>
#include <stdio.h>
#include "registered_consumer_protocol.h"

/* Synthetic transport fault probe; never included in a production binary. */
int main(void) {
  int pair[2];if(socketpair(AF_UNIX,SOCK_DGRAM,0,pair))return 1;
  ps_handoff_record_t expected;memset(&expected,0,sizeof(expected));
  memset(expected.handoff_id,1,16);memset(expected.coordination_id,2,32);
  ps_handoff_record_t wrong=expected;wrong.coordination_id[0]^=1;
  int got=-1;
  if(p7_send(pair[0],&wrong,P7_SOURCE_RELEASED,-1)||
     p7_receive(pair[1],&expected,P7_SOURCE_RELEASED,0,&got,0)==0)return 2;
  wrong=expected;wrong.handoff_id[0]^=1;
  if(p7_send(pair[0],&wrong,P7_SOURCE_RELEASED,-1)||
     p7_receive(pair[1],&expected,P7_SOURCE_RELEASED,0,&got,0)==0)return 3;
  if(p7_send(pair[0],&expected,P7_ARMED,-1)||
     p7_receive(pair[1],&expected,P7_SOURCE_RELEASED,0,&got,0)==0)return 4;
  int null=open("/dev/null",O_RDONLY|O_CLOEXEC);if(null<0)return 5;
  p7_message m;memset(&m,0,sizeof(m));m.type=P7_SOURCE_RELEASED;
  memcpy(m.handoff_id,expected.handoff_id,16);memcpy(m.coordination_id,expected.coordination_id,32);
  struct iovec iov={&m,sizeof(m)};struct msghdr msg;memset(&msg,0,sizeof(msg));
  union{struct cmsghdr align;char bytes[CMSG_SPACE(2*sizeof(int))];} ancillary;
  memset(&ancillary,0,sizeof(ancillary));msg.msg_iov=&iov;msg.msg_iovlen=1;
  msg.msg_control=ancillary.bytes;msg.msg_controllen=sizeof(ancillary);
  struct cmsghdr *h=CMSG_FIRSTHDR(&msg);h->cmsg_level=SOL_SOCKET;h->cmsg_type=SCM_RIGHTS;
  h->cmsg_len=CMSG_LEN(2*sizeof(int));int fds[2]={null,null};memcpy(CMSG_DATA(h),fds,sizeof(fds));
  if(sendmsg(pair[0],&msg,0)!=(ssize_t)sizeof(m)||
     p7_receive(pair[1],&expected,P7_SOURCE_RELEASED,0,&got,0)==0||got!=-1)return 6;
  if(send(pair[0],&m,sizeof(m)-1,0)!=(ssize_t)sizeof(m)-1||
     p7_receive(pair[1],&expected,P7_SOURCE_RELEASED,0,&got,0)==0)return 7;
  close(null);close(pair[0]);close(pair[1]);puts("PROTOCOL_FAULTS_REJECTED");return 0;
}
