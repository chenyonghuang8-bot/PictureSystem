#ifndef PS_PHASE7_COORDINATION_H
#define PS_PHASE7_COORDINATION_H

#define PS_COORD_MAGIC UINT64_C(0x434f4f5244563031)
typedef struct {
  uint64_t magic;
  int root_fd;
  int directory_fd;
  int lock_fd;
  dev_t root_device;
  ino_t root_inode;
  ino_t lock_inode;
  char root_path[PATH_MAX];
  char marker[33];
  char basename[70];
  char family[21];
  char sha[65];
  char byte_size[21];
  sm_marker binding;
  unsigned char coordination_id[CC_SHA256_DIGEST_LENGTH];
  int locked;
  int exclusive;
} ps_coord_t;
static int ps_handoff_admit_exclusive(ps_coord_t *coord);

static void ps_coord_finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  ps_coord_t *coord = data;
  if (coord == NULL) return;
  if (coord->locked && coord->lock_fd >= 0) (void)flock(coord->lock_fd, LOCK_UN);
  if (coord->lock_fd >= 0) close(coord->lock_fd);
  if (coord->directory_fd >= 0) close(coord->directory_fd);
  if (coord->root_fd >= 0) close(coord->root_fd);
  coord->magic = 0;
  free(coord);
}

static ps_coord_t *ps_coord_get(napi_env env, napi_value value) {
  ps_coord_t *coord = NULL;
  if (napi_get_value_external(env, value, (void **)&coord) != napi_ok ||
      coord == NULL || coord->magic != PS_COORD_MAGIC || coord->lock_fd < 0) {
    throw_code(env, "COORD_CLOSED", "Coordination handle is closed.");
    return NULL;
  }
  return coord;
}

static int ps_coord_decimal(const char *value) {
  if (value[0] == '\0' || (value[0] == '0' && value[1] != '\0')) return -1;
  for (const char *p = value; *p; p++) if (*p < '0' || *p > '9') return -1;
  return 0;
}

static int ps_coord_hex(const char *value, size_t count) {
  if (strlen(value) != count) return -1;
  for (size_t i = 0; i < count; i++) {
    char c = value[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return -1;
  }
  return 0;
}

static int ps_validate_coord_namespace(ps_coord_t *coord) {
  int fd=sm_validate_namespace(coord->root_fd,coord->root_path,&coord->binding,coord->directory_fd);
  if(fd<0)return -1;close(fd);return 0;
}

static int ps_coord_validate_file(ps_coord_t *coord, ino_t *inode) {
  struct stat open_status, named_status;
  if (ps_validate_coord_namespace(coord) != 0 ||
      fstat(coord->lock_fd, &open_status) != 0 ||
      fstatat(coord->directory_fd, coord->basename, &named_status,
              AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(open_status.st_mode) || !S_ISREG(named_status.st_mode) ||
      open_status.st_dev != coord->root_device ||
      named_status.st_dev != open_status.st_dev ||
      open_status.st_ino != named_status.st_ino ||
      open_status.st_uid != geteuid() || open_status.st_gid != getegid() ||
      open_status.st_nlink != 1 || (open_status.st_mode & 07777) != 0600 ||
      validate_no_extended_acl(coord->lock_fd) != 0) {
    if (errno == 0) errno = EPERM;
    return -1;
  }
  *inode = open_status.st_ino;
  return 0;
}

static napi_value ps_open_coordination(napi_env env, napi_callback_info info) {
  napi_value args[6]; size_t argc = 6;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  char path[PATH_MAX], expected[33], family[21], hash[65], size[21], kind[2];
  if (argc != 6 || get_string(env,args[0],path,sizeof(path)) != 0 ||
      get_string(env,args[1],expected,sizeof(expected)) != 0 ||
      get_string(env,args[2],family,sizeof(family)) != 0 ||
      get_string(env,args[3],hash,sizeof(hash)) != 0 ||
      get_string(env,args[4],size,sizeof(size)) != 0 ||
      get_string(env,args[5],kind,sizeof(kind)) != 0 ||
      ps_coord_hex(expected,32) != 0 || ps_coord_hex(hash,64) != 0 ||
      ps_coord_decimal(family) != 0 || ps_coord_decimal(size) != 0 ||
      !(kind[0] == 'L' || kind[0] == 'R')) {
    throw_code(env,"COORD_INVALID_KEY","Invalid coordination identity."); return NULL;
  }
  int root_fd = open_absolute_directory(path, 0);
  if (root_fd < 0) { throw_errno(env,"open coordination root"); return NULL; }
  struct stat root_status;
  char marker[33];
  if (validate_directory_fd(root_fd,&root_status) != 0 ||
      root_status.st_uid != geteuid() || (root_status.st_mode & 077) != 0 ||
      read_marker(root_fd,marker,sizeof(marker),0) != 0 ||
      strcmp(marker,expected) != 0) {
    close(root_fd); throw_code(env,"COORD_ROOT_INVALID","Coordination root mismatch."); return NULL;
  }
  sm_marker binding;char root_path[PATH_MAX];
  if(sm_read(root_fd,&binding)||binding.version!=2) {
    close(root_fd);throw_code(env,"COORD_ROOT_UPGRADE_REQUIRED","A controlled root upgrade is required.");return NULL;
  }
  if(fcntl(root_fd,F_GETPATH,root_path)) {close(root_fd);throw_code(env,"COORD_NAMESPACE_UNCERTAIN","Coordination namespace is unavailable.");return NULL;}
  int dir_fd = sm_validate_namespace(root_fd,root_path,&binding,-1);
  if (dir_fd < 0) { close(root_fd); throw_code(env,"COORD_NAMESPACE_UNCERTAIN","Coordination namespace is unavailable."); return NULL; }
  char material[256];
  int count = snprintf(material,sizeof(material),"%llu:%llu:%s:%s:%s:%s",
      (unsigned long long)root_status.st_dev,(unsigned long long)root_status.st_ino,
      marker,family,hash,size);
  if (count <= 0 || (size_t)count >= sizeof(material)) {
    close(dir_fd); close(root_fd); throw_code(env,"COORD_INVALID_KEY","Coordination key too long."); return NULL;
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(material,(CC_LONG)count,digest);
  char basename[70];
  for (size_t i = 0; i < sizeof(digest); i++)
    (void)snprintf(basename+i*2,3,"%02x",digest[i]);
  basename[64] = '.'; basename[65] = kind[0]; basename[66] = '\0';
  int created = 0;
  int fd = openat(dir_fd,basename,O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  if (fd >= 0) created = 1;
  else if (errno == EEXIST) fd = openat(dir_fd,basename,O_RDWR|O_NOFOLLOW|O_CLOEXEC);
  if (fd < 0) { close(dir_fd); close(root_fd); throw_errno(env,"open coordination lock"); return NULL; }
  ps_coord_t *coord = calloc(1,sizeof(*coord));
  if (coord == NULL) { close(fd); close(dir_fd); close(root_fd); throw_code(env,"STORAGE_NATIVE_ERROR","Coordination allocation failed."); return NULL; }
  *coord = (ps_coord_t){.magic=PS_COORD_MAGIC,.root_fd=root_fd,.directory_fd=dir_fd,
      .lock_fd=fd,.root_device=root_status.st_dev,.root_inode=root_status.st_ino};
  coord->binding=binding;strcpy(coord->root_path,root_path);
  strcpy(coord->marker,marker); strcpy(coord->basename,basename);
  strcpy(coord->family,family); strcpy(coord->sha,hash);
  strcpy(coord->byte_size,size);
  memcpy(coord->coordination_id,digest,sizeof(digest));
  ino_t inode = 0;
  if (ps_coord_validate_file(coord,&inode) != 0 ||
      (created && (full_sync_file_fd(fd) != 0 || sync_directory_fd(dir_fd) != 0)) ||
      fcntl(root_fd,F_GETPATH,coord->root_path) != 0) {
    ps_coord_finalize(env,coord,NULL); throw_errno(env,"validate coordination lock"); return NULL;
  }
  coord->lock_inode = inode;
  napi_value external;
  napi_create_external(env,coord,ps_coord_finalize,NULL,&external);
  return external;
}

static napi_value ps_try_coordination(napi_env env,napi_callback_info info) {
  napi_value args[2]; size_t argc=2;
  napi_get_cb_info(env,info,&argc,args,NULL,NULL);
  ps_coord_t *coord=ps_coord_get(env,args[0]); if (coord==NULL) return NULL;
  char mode[2];
  if (argc!=2 || get_string(env,args[1],mode,sizeof(mode))!=0 ||
      !(mode[0]=='S'||mode[0]=='X') || coord->locked) {
    throw_code(env,"COORD_INVALID_MODE","Invalid or reentrant coordination mode."); return NULL;
  }
  if(ps_validate_coord_namespace(coord)) {
    throw_code(env,"COORD_NAMESPACE_UNCERTAIN","Coordination namespace changed.");return NULL;
  }
  if (flock(coord->lock_fd,(mode[0]=='S'?LOCK_SH:LOCK_EX)|LOCK_NB)!=0) {
    if (errno!=EWOULDBLOCK && errno!=EAGAIN) { throw_errno(env,"acquire coordination lock"); return NULL; }
    napi_value no; napi_get_boolean(env,false,&no); return no;
  }
  int fresh_root=open_absolute_directory(coord->root_path,0);
  struct stat root_status,fresh_status;
  char marker[33]; ino_t inode=0;
  int valid=fresh_root>=0 && fstat(fresh_root,&fresh_status)==0 &&
      fresh_status.st_dev==coord->root_device && fresh_status.st_ino==coord->root_inode;
  if (fresh_root>=0) close(fresh_root);
  if (!valid || fstat(coord->root_fd,&root_status)!=0 ||
      root_status.st_dev!=coord->root_device || root_status.st_ino!=coord->root_inode ||
      read_marker(coord->root_fd,marker,sizeof(marker),0)!=0 ||
      strcmp(marker,coord->marker)!=0 ||
      ps_coord_validate_file(coord,&inode)!=0 || inode!=coord->lock_inode) {
    (void)flock(coord->lock_fd,LOCK_UN);
    throw_code(env,"COORD_NAMESPACE_UNCERTAIN","Coordination identity changed."); return NULL;
  }
  if (coord->basename[65]=='R' && mode[0]=='X') {
    int admission=ps_handoff_admit_exclusive(coord);
    if (admission!=1) {
      (void)flock(coord->lock_fd,LOCK_UN);
      if (admission<0) {
        throw_code(env,"HANDOFF_LEDGER_UNCERTAIN","Handoff ledger is unsafe or unreadable.");return NULL;
      }
      napi_value no;napi_get_boolean(env,false,&no);return no;
    }
  }
  if(ps_validate_coord_namespace(coord)) {
    (void)flock(coord->lock_fd,LOCK_UN);
    throw_code(env,"COORD_NAMESPACE_UNCERTAIN","Coordination namespace changed.");return NULL;
  }
  coord->locked=1;
  coord->exclusive=mode[0]=='X';
  napi_value yes; napi_get_boolean(env,true,&yes); return yes;
}

static napi_value ps_release_coordination(napi_env env,napi_callback_info info) {
  napi_value arg; size_t argc=1; napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  ps_coord_t *coord=ps_coord_get(env,arg); if (coord==NULL) return NULL;
  if (!coord->locked || flock(coord->lock_fd,LOCK_UN)!=0) {
    throw_code(env,"COORD_RELEASE_FAILED","Coordination release failed."); return NULL;
  }
  coord->locked=0; return undefined_value(env);
}

static napi_value ps_close_coordination(napi_env env,napi_callback_info info) {
  napi_value arg; size_t argc=1; napi_get_cb_info(env,info,&argc,&arg,NULL,NULL);
  ps_coord_t *coord=ps_coord_get(env,arg); if (coord==NULL) return NULL;
  if (coord->locked) { throw_code(env,"COORD_STILL_HELD","Release coordination guard before close."); return NULL; }
  if (close(coord->lock_fd)!=0) { throw_errno(env,"close coordination lock"); return NULL; }
  coord->lock_fd=-1; close(coord->directory_fd); coord->directory_fd=-1;
  close(coord->root_fd); coord->root_fd=-1;
  return undefined_value(env);
}

#endif
