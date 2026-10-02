#ifndef PS_STORAGE_MARKER_H
#define PS_STORAGE_MARKER_H
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <unistd.h>

#define SM_FN static __attribute__((unused))
#define SM_LIMIT 512
typedef struct {
  unsigned version;
  char id[33];
  uint64_t fields[10];
  char bytes[SM_LIMIT];
  size_t length;
  struct stat file;
} sm_marker;

SM_FN int sm_parse(const char *bytes, size_t length, sm_marker *out) {
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
    if(length-at!=7||memcmp(bytes+at,":INIT1\n",7))return -1;
  }
  memcpy(out->bytes,bytes,length);out->length=length;
  return 0;
}

SM_FN int sm_no_acl(int fd) {
  acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED);
  if(!acl)return errno==ENOENT?0:-1;
  acl_entry_t entry;errno=0;int n=acl_get_entry(acl,ACL_FIRST_ENTRY,&entry);int saved=errno;acl_free(acl);
  if(n==0){errno=EPERM;return -1;}
  if(saved!=EINVAL){errno=saved?saved:EIO;return -1;}
  return 0;
}
SM_FN int sm_same_file(const struct stat *a,const struct stat *b) {
  return a->st_dev==b->st_dev&&a->st_ino==b->st_ino&&a->st_uid==b->st_uid&&
    a->st_gid==b->st_gid&&a->st_mode==b->st_mode&&a->st_nlink==b->st_nlink&&
    a->st_size==b->st_size&&a->st_mtimespec.tv_sec==b->st_mtimespec.tv_sec&&
    a->st_mtimespec.tv_nsec==b->st_mtimespec.tv_nsec&&
    a->st_ctimespec.tv_sec==b->st_ctimespec.tv_sec&&a->st_ctimespec.tv_nsec==b->st_ctimespec.tv_nsec;
}
SM_FN int sm_read_contents(int root,sm_marker *out) {
  int fd=openat(root,".storage-root",O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
  if(fd<0)return -1;
  struct stat before,after,named,root_st;char bytes[SM_LIMIT+1];size_t count=0;int bad=0;
  if(fstat(fd,&before)||fstat(root,&root_st)||!S_ISREG(before.st_mode)||
    before.st_uid!=geteuid()||before.st_nlink!=1||before.st_dev!=root_st.st_dev||
    (before.st_mode&077)!=0||before.st_size<=0||before.st_size>SM_LIMIT||sm_no_acl(fd))bad=1;
  while(!bad && count<sizeof(bytes)) {
    ssize_t n=read(fd,bytes+count,sizeof(bytes)-count);
    if(n<0){if(errno==EINTR)continue;bad=1;break;}
    if(!n)break;count+=(size_t)n;
  }
  if(!bad && (count!=(size_t)before.st_size||sm_parse(bytes,count,out)||
    fstat(fd,&after)||fstatat(root,".storage-root",&named,AT_SYMLINK_NOFOLLOW)||
    !sm_same_file(&before,&after)||!sm_same_file(&after,&named)||sm_no_acl(fd)))bad=1;
  if(!bad && out->version==2 && ((before.st_mode&07777)!=0600||before.st_gid!=getegid()||
    out->fields[0]!=(uint64_t)root_st.st_dev||out->fields[1]!=(uint64_t)root_st.st_ino))bad=1;
  if(close(fd))bad=1;
  if(bad){errno=EPERM;return -1;}
  out->file=after;return 0;
}
#ifdef PS_STORAGE_TEST_HOOKS
static int sm_test_fence_stat_error=0;
#endif
SM_FN int sm_fence_absent(int root) {
  struct stat st;
#ifdef PS_STORAGE_TEST_HOOKS
  if(sm_test_fence_stat_error){errno=EIO;return -1;}
#endif
  if(fstatat(root,".storage-root.initializing",&st,AT_SYMLINK_NOFOLLOW)==0){errno=EPERM;return -1;}
  return errno==ENOENT?0:-1;
}
// Each read owns a distinct open file description: never convert or unlock
// the business root FD (or an initializer's exclusive root lock).
SM_FN int sm_admission_open(int root) {
  struct stat expected,actual;
  int fd=openat(root,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if(fd<0)return -1;
  if(fstat(root,&expected)||fstat(fd,&actual)||expected.st_dev!=actual.st_dev||expected.st_ino!=actual.st_ino) {
    close(fd);errno=EPERM;return -1;
  }
  if(flock(fd,LOCK_SH|LOCK_NB)){int saved=errno;close(fd);errno=saved;return -1;}
  return fd;
}
SM_FN int sm_read(int root,sm_marker *out) {
  int fd=sm_admission_open(root);if(fd<0)return -1;
  struct stat before,after;int bad=fstat(root,&before)||sm_fence_absent(root)||
    sm_read_contents(root,out)||sm_fence_absent(root)||fstat(root,&after)||
    before.st_dev!=after.st_dev||before.st_ino!=after.st_ino;
  int saved=errno;
  int unlocked=flock(fd,LOCK_UN),closed=close(fd);
  if(unlocked||closed){bad=1;saved=EIO;}
  if(bad){errno=saved?saved:EPERM;return -1;}return 0;
}
SM_FN int sm_dir_properties(const struct stat *st) {
  return S_ISDIR(st->st_mode)&&st->st_uid==geteuid()&&st->st_gid==getegid()&&(st->st_mode&07777)==0700;
}
SM_FN int sm_dir_private(int fd,struct stat *st) {
  return fstat(fd,st)||!sm_dir_properties(st)||sm_no_acl(fd)?-1:0;
}
SM_FN int sm_dir_binding(const struct stat *st,const uint64_t *identity) {
  return st->st_dev>0&&st->st_ino>0&&st->st_birthtimespec.tv_sec>=0&&
    st->st_birthtimespec.tv_nsec>=0&&st->st_birthtimespec.tv_nsec<=999999999&&
    (uint64_t)st->st_dev==identity[0]&&(uint64_t)st->st_ino==identity[1]&&
    (uint64_t)st->st_birthtimespec.tv_sec==identity[2]&&
    (uint64_t)st->st_birthtimespec.tv_nsec==identity[3];
}
// The exact existing absolute-path policy: no symlink, untrusted owner,
// group/other writer or extended ACL at any ancestor. No mkdir here.
SM_FN int sm_open_path(const char *path) {
  if(path[0]!='/'||!path[1]||strlen(path)>=PATH_MAX){errno=EINVAL;return -1;}
  int fd=open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC);if(fd<0)return -1;
  char copy[PATH_MAX];strcpy(copy,path+1);char *save=NULL;
  for(char *part=strtok_r(copy,"/",&save);part;part=strtok_r(NULL,"/",&save)) {
    if(!strcmp(part,".")||!strcmp(part,"..")){close(fd);errno=EINVAL;return -1;}
    int next=openat(fd,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);struct stat st;
    int bad=next<0||fstat(next,&st)||!S_ISDIR(st.st_mode)||
      (st.st_uid!=geteuid()&&st.st_uid!=0)||(st.st_mode&(S_IWGRP|S_IWOTH))||sm_no_acl(next);
    close(fd);if(bad){if(next>=0)close(next);errno=EPERM;return -1;}fd=next;
  }
  return fd;
}
// Shared by coordination, purge, handoff and the fixed supervisor binaries.
// Returns a newly owned FD for the persisted v1 directory. Never creates it.
SM_FN int sm_validate_namespace_contents(int root,const char *path,const sm_marker *accepted,const sm_marker *verified,int held_v1) {
  sm_marker current=*verified;struct stat st,named,opened,held;int fresh=-1,coord=-1,v1=-1;
  if(!accepted||accepted->version!=2||current.version!=2||
    current.length!=accepted->length||memcmp(current.bytes,accepted->bytes,current.length)||
    !sm_same_file(&current.file,&accepted->file)||fstat(root,&st)||sm_dir_private(root,&st))goto fail;
  fresh=sm_open_path(path);
  if(fresh<0||fstat(fresh,&opened)||opened.st_dev!=st.st_dev||opened.st_ino!=st.st_ino)goto fail;
  coord=openat(root,".coord",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if(coord<0||sm_dir_private(coord,&opened)||!sm_dir_binding(&opened,current.fields+2)||
    opened.st_dev!=st.st_dev||fstatat(root,".coord",&named,AT_SYMLINK_NOFOLLOW)||
    !sm_dir_binding(&named,current.fields+2))goto fail;
  v1=openat(coord,"v1",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if(v1<0||sm_dir_private(v1,&opened)||!sm_dir_binding(&opened,current.fields+6)||
    opened.st_dev!=st.st_dev||fstatat(coord,"v1",&named,AT_SYMLINK_NOFOLLOW)||
    !sm_dir_binding(&named,current.fields+6))goto fail;
  if(held_v1>=0&&(fstat(held_v1,&held)||!sm_dir_binding(&held,current.fields+6)))goto fail;
  // Recheck the complete named chain after opening both segments.
  if(fstatat(root,".coord",&named,AT_SYMLINK_NOFOLLOW)||!sm_dir_binding(&named,current.fields+2)||
    fstatat(coord,"v1",&named,AT_SYMLINK_NOFOLLOW)||!sm_dir_binding(&named,current.fields+6))goto fail;
  close(coord);close(fresh);return v1;
fail:
  if(v1>=0)close(v1);if(coord>=0)close(coord);if(fresh>=0)close(fresh);errno=EPERM;return -1;
}

SM_FN int sm_validate_namespace(int root,const char *path,const sm_marker *accepted,int held_v1) {
  sm_marker current;if(sm_read(root,&current))return -1;
  return sm_validate_namespace_contents(root,path,accepted,&current,held_v1);
}

// A registered supervisor derives the trusted named chain from its exact
// record FD, then verifies the same persistent marker binding. No ledger format
// change and no permission based on a newly observed empty namespace.
SM_FN int sm_record_namespace(int record,const char *expected_marker,uint64_t device,uint64_t inode,
    const unsigned char key[32],const unsigned char record_id[16]) {
  char path[PATH_MAX],base[67],name[37];
  if(fcntl(record,F_GETPATH,path))return -1;
  for(size_t i=0;i<32;i++)snprintf(base+i*2,3,"%02x",key[i]);memcpy(base+64,".h",3);
  for(size_t i=0;i<16;i++)snprintf(name+i*2,3,"%02x",record_id[i]);memcpy(name+32,".rec",5);
  const char *parts[]={name,base,"v1",".coord"};
  for(size_t i=0;i<4;i++){char *last=strrchr(path,'/');if(!last||strcmp(last+1,parts[i]))return -1;*last=0;}
  int root=sm_open_path(path);sm_marker marker;int v1=-1,ledger=-1;struct stat st,named;
  int bad=root<0||sm_read(root,&marker)||marker.version!=2||memcmp(marker.id,expected_marker,33)||
    marker.fields[0]!=device||marker.fields[1]!=inode;
  if(!bad){v1=sm_validate_namespace(root,path,&marker,-1);bad=v1<0;}
  if(!bad){ledger=openat(v1,base,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);bad=ledger<0||sm_dir_private(ledger,&st)||st.st_dev!=(dev_t)device;}
  if(!bad)bad=fstat(record,&st)||fstatat(ledger,name,&named,AT_SYMLINK_NOFOLLOW)||!sm_same_file(&st,&named);
  if(ledger>=0)close(ledger);if(v1>=0)close(v1);if(root>=0)close(root);return bad?-1:0;
}
#endif
