/**
 * 合成挂起 probe 工具：不输出、保持存活，直到被 SIGTERM/SIGKILL 终止。
 * 只用于取消/超时用例；默认信号处理即退出，不安装任何 handler。
 */
setTimeout(() => {}, 60_000);
