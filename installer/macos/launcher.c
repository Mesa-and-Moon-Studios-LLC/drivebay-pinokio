/*
 * Universal stub for Drivebay.app. package-dmg.sh compiles this on the macOS
 * runner as arm64+x86_64 so both disk images launch. It clears the download
 * quarantine on the bundle (right-click Open gets this far) and runs the
 * setup script in Resources.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <limits.h>
#include <libgen.h>
#include <mach-o/dyld.h>
#include <sys/wait.h>

static void clear_quarantine(const char *path) {
    pid_t pid = fork();
    if (pid < 0) return;
    if (pid == 0) {
        execl("/usr/bin/xattr", "xattr", "-dr", "com.apple.quarantine", path, (char *)0);
        _exit(0);
    }
    waitpid(pid, 0, 0);
}

int main(void) {
    char exe[PATH_MAX];
    uint32_t size = sizeof(exe);
    if (_NSGetExecutablePath(exe, &size) != 0) return 1;

    char real[PATH_MAX];
    if (!realpath(exe, real)) return 1;

    char dirbuf[PATH_MAX];
    strncpy(dirbuf, real, sizeof(dirbuf) - 1);
    dirbuf[sizeof(dirbuf) - 1] = '\0';
    char *dir = dirname(dirbuf);

    char app_rel[PATH_MAX];
    snprintf(app_rel, sizeof(app_rel), "%s/../..", dir);
    char app[PATH_MAX];
    if (realpath(app_rel, app)) clear_quarantine(app);

    char script_rel[PATH_MAX];
    snprintf(script_rel, sizeof(script_rel), "%s/../Resources/drivebay-setup.sh", dir);
    char script[PATH_MAX];
    if (!realpath(script_rel, script)) {
        fprintf(stderr, "Drivebay setup script is missing\n");
        return 1;
    }

    execl("/bin/bash", "bash", script, (char *)0);
    perror("bash");
    return 1;
}
