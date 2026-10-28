/*
 * T-LOCAL-013H：音频执行器受限 launcher。
 *
 * 只做两件事：在 exec 目标之前设置 macOS/BSD 已证明可用的资源上限，然后用
 * execv 以“同一进程、同一进程组”替换为目标二进制。它不解析命令行选项、不读
 * 环境变量、不做 PATH 搜索、不联网、不写文件。
 *
 * argv 约定（由 server/audio-executor.mjs 内部固定）：
 *   launcher <absolute-binary> <snapshot-path> --json --brief
 *
 * 编译期常量可由测试用 -D 降低（只用于临时合成测试），生产构建不得通过运行时
 * 环境/参数提高或关闭限制。设置失败一律以固定非零码退出，绝不无约束 exec。
 */
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef AUDIO_EXECUTOR_LIMIT_CPU_SECONDS
#define AUDIO_EXECUTOR_LIMIT_CPU_SECONDS 180
#endif
#ifndef AUDIO_EXECUTOR_LIMIT_FSIZE_BYTES
#define AUDIO_EXECUTOR_LIMIT_FSIZE_BYTES (64 * 1024 * 1024)
#endif
#ifndef AUDIO_EXECUTOR_LIMIT_NOFILE
#define AUDIO_EXECUTOR_LIMIT_NOFILE 256
#endif

static void write_fixed(const char *message) {
  const char *cursor = message;
  while (*cursor) cursor++;
  (void)write(2, message, (size_t)(cursor - message));
}

static void fail(const char *message) {
  write_fixed(message);
  _exit(125);
}

int main(int argc, char *argv[]) {
  struct rlimit limit;

  if (argc < 2 || argv[1] == 0 || argv[1][0] != '/') {
    fail("audio-executor-launcher: invalid target\n");
  }

  /* 子进程创建的文件默认只对本人可读写，减少意外共享。 */
  (void)umask(0077);

  limit.rlim_cur = (rlim_t)AUDIO_EXECUTOR_LIMIT_CPU_SECONDS;
  limit.rlim_max = (rlim_t)AUDIO_EXECUTOR_LIMIT_CPU_SECONDS + 1;
  if (setrlimit(RLIMIT_CPU, &limit) != 0) fail("audio-executor-launcher: cpu limit failed\n");

  limit.rlim_cur = (rlim_t)AUDIO_EXECUTOR_LIMIT_FSIZE_BYTES;
  limit.rlim_max = (rlim_t)AUDIO_EXECUTOR_LIMIT_FSIZE_BYTES;
  if (setrlimit(RLIMIT_FSIZE, &limit) != 0) fail("audio-executor-launcher: file size limit failed\n");

  limit.rlim_cur = (rlim_t)AUDIO_EXECUTOR_LIMIT_NOFILE;
  limit.rlim_max = (rlim_t)AUDIO_EXECUTOR_LIMIT_NOFILE;
  if (setrlimit(RLIMIT_NOFILE, &limit) != 0) fail("audio-executor-launcher: file descriptor limit failed\n");

  limit.rlim_cur = 0;
  limit.rlim_max = 0;
  (void)setrlimit(RLIMIT_CORE, &limit);

  execv(argv[1], &argv[1]);
  fail("audio-executor-launcher: exec failed\n");
  return 127;
}
