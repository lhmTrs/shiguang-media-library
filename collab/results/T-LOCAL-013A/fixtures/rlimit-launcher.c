/*
 * T-LOCAL-013A：仅用于隔离实验的 rlimit launcher。
 * 用法：rlimit-launcher <cpu_soft> <cpu_hard> <fsize_bytes> <nofile> <program> [args...]
 * 0 表示不设置该项。exec 前设置 RLIMIT_CPU / RLIMIT_FSIZE / RLIMIT_NOFILE。
 * RLIMIT_AS 在 macOS 上不作为硬内存隔离，本 launcher 故意不设置；NPROC 也留给报告说明。
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>

static int parse_nonnegative(const char *text, rlim_t *out) {
  char *end = NULL;
  errno = 0;
  unsigned long long value = strtoull(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0') return -1;
  *out = (rlim_t)value;
  return 0;
}

static int set_limit(int resource, const char *soft_text, const char *hard_text, const char *name) {
  rlim_t soft = 0;
  rlim_t hard = 0;
  if (parse_nonnegative(soft_text, &soft) != 0 || parse_nonnegative(hard_text, &hard) != 0) {
    fprintf(stderr, "invalid %s limit\n", name);
    return -1;
  }
  if (soft == 0 && hard == 0) return 0;
  struct rlimit limit;
  limit.rlim_cur = soft;
  limit.rlim_max = hard;
  if (setrlimit(resource, &limit) != 0) {
    fprintf(stderr, "setrlimit(%s): %s\n", name, strerror(errno));
    return -1;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 6) {
    fprintf(stderr, "usage: rlimit-launcher cpu_soft cpu_hard fsize nofile program [args...]\n");
    return 125;
  }
  if (set_limit(RLIMIT_CPU, argv[1], argv[2], "RLIMIT_CPU") != 0) return 125;
  if (set_limit(RLIMIT_FSIZE, argv[3], argv[3], "RLIMIT_FSIZE") != 0) return 125;
  if (set_limit(RLIMIT_NOFILE, argv[4], argv[4], "RLIMIT_NOFILE") != 0) return 125;
  execvp(argv[5], &argv[5]);
  fprintf(stderr, "execvp(%s): %s\n", argv[5], strerror(errno));
  return 126;
}
