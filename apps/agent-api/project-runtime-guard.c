#define _GNU_SOURCE
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <seccomp.h>

/* Only the trusted supervisor calls this launcher. Drop its capabilities before
 * setting up unprivileged namespaces or executing any project-owned code. */
static void fail(const char *message) { perror(message); exit(126); }
int main(int argc, char **argv) {
  const pid_t supervisor = getppid();
  if (argc == 3 && !strcmp(argv[1], "--emit-filter")) {
    scmp_filter_ctx filter = seccomp_init(SCMP_ACT_ALLOW);
    if (!filter) fail("command seccomp");
    const char *denied[] = { "unshare", "setns", "mount", "umount2", "pivot_root", "ptrace", "process_vm_readv", "process_vm_writev", "bpf", NULL };
    for (int i = 0; denied[i]; i++) {
      int call = seccomp_syscall_resolve_name(denied[i]);
      if (call != __NR_SCMP_ERROR && seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), call, 0)) fail("command seccomp rule");
    }
    int clone3 = seccomp_syscall_resolve_name("clone3");
    if (clone3 != __NR_SCMP_ERROR && seccomp_rule_add(filter, SCMP_ACT_ERRNO(ENOSYS), clone3, 0)) fail("clone3 seccomp");
    unsigned long flags[] = { CLONE_NEWUSER, CLONE_NEWNS, CLONE_NEWNET, CLONE_NEWPID, CLONE_NEWIPC, CLONE_NEWUTS, CLONE_NEWCGROUP };
    for (size_t i = 0; i < sizeof(flags) / sizeof(flags[0]); i++)
      if (seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(clone), 1,
          SCMP_A0(SCMP_CMP_MASKED_EQ, flags[i], flags[i]))) fail("clone seccomp");
    int output = open(argv[2], O_CREAT | O_EXCL | O_WRONLY, 0444);
    if (output < 0 || seccomp_export_bpf(filter, output)) fail("command seccomp export");
    close(output); seccomp_release(filter); return 0;
  }
  int check = argc == 2 && !strcmp(argv[1], "--check");
  if (!check) {
    const char *expected = getenv("NPATI_RUNTIME_SUPERVISOR_PID");
    char *end = NULL;
    if (!expected || !*expected) return 126;
    const long owner = strtol(expected, &end, 10);
    if (!end || *end || owner <= 0 || owner != (long)supervisor) return 126;
    unsetenv("NPATI_RUNTIME_SUPERVISOR_PID");
  }
  if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0)) fail("early supervisor death signal");
  if (getppid() != supervisor) raise(SIGKILL);
  if (geteuid() != 0 || (!check && argc < 6)) return 126;
  unsigned long uid = 10000;
  if (!check) {
    char *end;
    uid = strtoul(argv[1], &end, 10);
    if (*end || uid < 10000 || uid > 60000) return 126;
    unsigned long port = strtoul(argv[3], &end, 10);
    if (*end || port < 1024 || port > 65000) return 126;
    char project[PATH_MAX], cwd[PATH_MAX];
    struct stat st;
    if (!realpath(argv[2], project) || !realpath(argv[4], cwd)) fail("project path");
    size_t length = strlen(project);
    if (strncmp(project, "/projects/", 10) || strchr(project + 10, '/') ||
        strncmp(cwd, project, length) || (cwd[length] && cwd[length] != '/') ||
        stat(project, &st) || !S_ISDIR(st.st_mode) || st.st_uid != uid) return 126;
  }
  if (setgroups(0, NULL) || setgid(uid) || setuid(uid)) fail("project uid");
  /* setuid clears PDEATHSIG: arm it only after dropping credentials.
   * Kernel parent tracking, not a saved PID, kills this launcher on supervisor
   * death. Bubblewrap --die-with-parent then tears down its PID namespace. */
  if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0)) fail("supervisor death signal");
  if (getppid() != supervisor) raise(SIGKILL);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("no_new_privs");
  struct rlimit processes = { .rlim_cur = 512, .rlim_max = 512 };
  struct rlimit files = { .rlim_cur = 4096, .rlim_max = 4096 };
  struct rlimit core = { .rlim_cur = 0, .rlim_max = 0 };
  if (setrlimit(RLIMIT_NPROC, &processes) || setrlimit(RLIMIT_NOFILE, &files) || setrlimit(RLIMIT_CORE, &core)) fail("project limits");
  char **args = calloc((size_t)argc + 3, sizeof(char *));
  if (!args) fail("launcher args");
  args[0] = "/usr/local/bin/node";
  args[1] = "/opt/npati-runtime/project-runtime-launcher.mjs";
  for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
  execv(args[0], args);
  fail("project namespace launcher");
}
