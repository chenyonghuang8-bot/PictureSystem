#define _DARWIN_C_SOURCE 1
#include <stdlib.h>
#include <stdio.h>
#include "registered_consumer_protocol.h"
int main(int argc,char **argv) {
  if(argc!=6||!p7_is_socket(3)||p7_bootstrap_receive(3)!=0)return 64;
#ifdef PS_P7_TEST_BARRIERS
  /* Observe the inherited set before sandbox-exec may open its own handles. */
  for(int fd=4;fd<8192;fd++)if(fcntl(fd,F_GETFD)!=-1)return 71;
#endif
  char root[4112],home[4112],child[4112];
  if(snprintf(root,sizeof(root),"MEDIA_ROOT=%s",argv[3])<0||
     snprintf(home,sizeof(home),"HOME_ROOT=%s",argv[4])<0||
     snprintf(child,sizeof(child),"CHILD=%s",argv[2])<0)return 64;
  char *const args[]={"sandbox-exec","-f",argv[1],"-D",root,"-D",child,"-D",home,argv[2],argv[5],NULL};
  char *const env[]={"PATH=/usr/bin:/bin","LANG=C",NULL};
  execve("/usr/bin/sandbox-exec",args,env);return 71;
}
