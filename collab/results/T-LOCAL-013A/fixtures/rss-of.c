/* T-LOCAL-013A：短采样指定 pid 的 resident size（KiB）。仅实验辅助，不进入生产。 */
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char *end = NULL;
  long pid = strtol(argv[1], &end, 10);
  if (end == argv[1] || *end != '\0' || pid <= 0) return 2;
  struct proc_taskinfo info;
  int size = proc_pidinfo((int)pid, PROC_PIDTASKINFO, 0, &info, sizeof(info));
  if (size != (int)sizeof(info)) {
    perror("proc_pidinfo");
    return 1;
  }
  printf("%llu\n", (unsigned long long)(info.pti_resident_size / 1024));
  return 0;
}
