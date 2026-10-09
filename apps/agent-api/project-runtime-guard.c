#define _GNU_SOURCE
#include <linux/landlock.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
#include <grp.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The trusted supervisor runs as root. Every project subprocess drops privileges
 * and inherits a fail-closed Landlock policy, including its package scripts. */
static void fail(const char *message) { perror(message); exit(126); }
static void allow_path(int ruleset, const char *path, __u64 rights) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) { if (errno == ENOENT) return; fail(path); }
  struct stat st;
  if (fstat(fd, &st)) fail("fstat");
  if (!S_ISDIR(st.st_mode)) rights &= LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_TRUNCATE | LANDLOCK_ACCESS_FS_IOCTL_DEV;
  struct landlock_path_beneath_attr rule = { .allowed_access = rights, .parent_fd = fd };
  if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) fail("landlock path");
  close(fd);
}
static void allow_port(int ruleset, unsigned port, __u64 rights) {
  struct landlock_net_port_attr rule = { .allowed_access = rights, .port = port };
  if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_NET_PORT, &rule, 0)) fail("landlock port");
}
int main(int argc, char **argv) {
  int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 6) { fprintf(stderr, "Shared project runtime requires Landlock ABI >= 6 (Linux >= 6.12); refusing unisolated execution\n"); return 126; }
  if (argc == 2 && !strcmp(argv[1], "--check")) { printf("landlock:%d\n", abi); return 0; }
  if (argc < 6 || geteuid() != 0) { fprintf(stderr, "Invalid trusted project launcher request\n"); return 126; }
  unsigned uid = strtoul(argv[1], NULL, 10), port = strtoul(argv[3], NULL, 10);
  if (uid < 10000 || uid > 60000 || port < 1024 || port > 65535 || strncmp(argv[2], "/projects/", 10)) return 126;
  const __u64 read = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
  const __u64 all = (1ULL << 16) - 1;
  struct landlock_ruleset_attr rules = {
    .handled_access_fs = all,
    .handled_access_net = LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP,
    .scoped = LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | LANDLOCK_SCOPE_SIGNAL
  };
  int fd = syscall(SYS_landlock_create_ruleset, &rules, sizeof(rules), 0);
  if (fd < 0) fail("landlock ruleset");
  const char *paths[] = { "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/proc", "/opt/npati-package-managers", "/opt/npati-project-toolchain", "/opt/npati-runtime/prepare-project-dependencies.cjs", NULL };
  for (int i = 0; paths[i]; i++) allow_path(fd, paths[i], read);
  allow_path(fd, argv[2], all);
  allow_path(fd, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_IOCTL_DEV);
  allow_path(fd, "/dev/urandom", LANDLOCK_ACCESS_FS_READ_FILE);
  allow_path(fd, "/dev/random", LANDLOCK_ACCESS_FS_READ_FILE);
  allow_port(fd, port, LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP);
  allow_port(fd, 8080, LANDLOCK_ACCESS_NET_CONNECT_TCP);
  if (chdir(argv[4])) fail("project cwd");
  if (setgroups(0, NULL) || setgid(uid) || setuid(uid)) fail("project uid");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("no_new_privs");
  if (syscall(SYS_landlock_restrict_self, fd, 0)) fail("landlock restrict");
  close(fd);
  struct rlimit processes = { .rlim_cur = 512, .rlim_max = 512 };
  struct rlimit files = { .rlim_cur = 4096, .rlim_max = 4096 };
  struct rlimit core = { .rlim_cur = 0, .rlim_max = 0 };
  if (setrlimit(RLIMIT_NPROC, &processes) || setrlimit(RLIMIT_NOFILE, &files) || setrlimit(RLIMIT_CORE, &core)) fail("project limits");
  execvp(argv[5], &argv[5]);
  fail("project exec");
}
