/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "Hal.h"
#include "HalLog.h"

#include "mozilla/ClearOnShutdown.h"
#include "mozilla/Services.h"
#include "mozilla/Sprintf.h"
#include "mozilla/StaticPrefs_dom.h"
#include "mozilla/StaticPtr.h"
#include "nsIObserver.h"
#include "nsIObserverService.h"
#include "nsPrintfCString.h"
#include "nsString.h"
#include "nsTHashMap.h"
#include "nsThreadUtils.h"

#ifdef MOZ_ENABLE_DBUS
#  include <gio/gio.h>
#  include "mozilla/GRefPtr.h"
#  include "mozilla/widget/AsyncDBus.h"
#endif

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <sys/stat.h>
#include <unistd.h>

using namespace mozilla::hal;

namespace mozilla::hal_impl {

/* The Linux OOM score is a value computed by the kernel ranging between 0 and
 * 1000 and indicating how likely is a process to be killed when memory is
 * tight. The larger the value the more likely a process is to be killed. The
 * score is computed based on the amount of memory used plus an adjustment
 * value. We chose our adjustment values to make it likely that processes are
 * killed in the following order:
 *
 * 1. preallocated processes
 * 2. background processes
 * 3. background processes playing video (but no audio)
 * 4. foreground processes or processes playing or recording audio
 * 5. gpu process or anything else high priority
 * 6. the parent process
 *
 * At the time of writing (2022) the base score for a process consuming very
 * little memory seems to be around ~667. Our adjustments are thus designed
 * to ensure this order starting from a 667 baseline but trying not to go too
 * close to the 1000 limit where they would be clamped. */

const uint32_t kParentOomScoreAdjust = 0;
const uint32_t kForegroundHighOomScoreAdjust = 100;
const uint32_t kForegroundOomScoreAdjust = 133;
const uint32_t kBackgroundPerceivableOomScoreAdjust = 167;
const uint32_t kBackgroundOomScoreAdjust = 200;
const uint32_t kPreallocOomScoreAdjust = 233;

static uint32_t OomScoreAdjForPriority(ProcessPriority aPriority) {
  switch (aPriority) {
    case PROCESS_PRIORITY_BACKGROUND:
      return kBackgroundOomScoreAdjust;
    case PROCESS_PRIORITY_BACKGROUND_PERCEIVABLE:
      return kBackgroundPerceivableOomScoreAdjust;
    case PROCESS_PRIORITY_PREALLOC:
      return kPreallocOomScoreAdjust;
    case PROCESS_PRIORITY_FOREGROUND:
      return kForegroundOomScoreAdjust;
    case PROCESS_PRIORITY_FOREGROUND_HIGH:
      return kForegroundHighOomScoreAdjust;
    default:
      return kParentOomScoreAdjust;
  }
}

/* Besides the OOM score, priorities are mapped onto cgroup v2 groups so that
 * the kernel's CPU scheduler and memory reclaim can tell the browser's own
 * interface apart from web content:
 *
 *   <delegated cgroup>/ui          the parent process and the GPU process
 *   <delegated cgroup>/foreground  content processes in the foreground
 *   <delegated cgroup>/background  content processes in the background
 *   <delegated cgroup>/helpers     the fork server and other utility processes
 *
 * "ui" gets a higher cpu.weight and a memory.low protection, "background" a
 * lower cpu.weight. Group weights do not dilute as more content processes are
 * started, which per-process nice values would.
 *
 * Creating child groups is only allowed in a cgroup delegated to us, so we
 * ask the systemd user manager for a transient scope with Delegate=yes in our
 * slice and move ourselves and our children into it. This happens once the
 * profile's preferences are loaded, early enough that most of the parent
 * process's memory is allocated, and therefore charged, inside "ui": the
 * kernel does not move existing memory charges when a process changes group.
 * For the same reason only CPU weights follow content processes between
 * foreground and background, which is what moving them changes immediately.
 *
 * memory.low only protects as much as every ancestor cgroup also protects.
 * Without a matching MemoryLow= on the user's slices it has no effect, and
 * the CPU weights still apply. */

namespace {

enum class Leaf { Ui, Foreground, Background, Helpers };

const char* LeafName(Leaf aLeaf) {
  switch (aLeaf) {
    case Leaf::Ui:
      return "ui";
    case Leaf::Foreground:
      return "foreground";
    case Leaf::Background:
      return "background";
    case Leaf::Helpers:
      return "helpers";
  }
  return "helpers";
}

enum class State { Unset, Starting, Ready, Off };

State sState = State::Unset;
StaticAutoPtr<nsCString> sRoot;
// The cgroup we were started in, while it may still hold processes we
// started before moving to the delegated scope.
StaticAutoPtr<nsCString> sLaunchCgroup;
// Priorities set while the delegated cgroup is being set up.
StaticAutoPtr<nsTHashMap<uint32_t, ProcessPriority>> sPending;

bool ReadFile(const char* aPath, nsACString& aOut) {
  int fd = open(aPath, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    return false;
  }
  aOut.Truncate();
  char buf[4096];
  ssize_t n;
  while ((n = read(fd, buf, sizeof(buf))) > 0) {
    aOut.Append(buf, n);
  }
  (void)close(fd);
  return n == 0;
}

bool WriteFile(const char* aPath, const nsACString& aValue) {
  int fd = open(aPath, O_WRONLY | O_CLOEXEC);
  if (fd < 0) {
    return false;
  }
  ssize_t written = write(fd, aValue.BeginReading(), aValue.Length());
  int error = errno;
  (void)close(fd);
  errno = error;
  return written == ssize_t(aValue.Length());
}

// The cgroup v2 directory of aPid.
bool CgroupOf(int aPid, nsACString& aPath) {
  nsAutoCString content;
  if (!ReadFile(nsPrintfCString("/proc/%d/cgroup", aPid).get(), content)) {
    return false;
  }
  for (const auto& line : content.Split('\n')) {
    if (StringBeginsWith(line, "0::/"_ns)) {
      aPath = "/sys/fs/cgroup"_ns + Substring(line, 3);
      aPath.Trim("/", false, true);
      return true;
    }
  }
  return false;
}

// Child processes end their command line with their type: "tab" for content
// processes, "gpu", "socket", "rdd" and so on. Fork server children rewrite
// their argv into one space-separated string, so both separators count.
nsAutoCString ProcessType(int aPid) {
  nsAutoCString cmdline;
  if (!ReadFile(nsPrintfCString("/proc/%d/cmdline", aPid).get(), cmdline)) {
    return {};
  }
  cmdline.ReplaceChar('\0', ' ');
  cmdline.Trim(" ", false, true);
  return nsAutoCString(Substring(cmdline, cmdline.RFindChar(' ') + 1));
}

int ParentPid(int aPid) {
  nsAutoCString stat;
  if (!ReadFile(nsPrintfCString("/proc/%d/stat", aPid).get(), stat)) {
    return 0;
  }
  // The command name in parentheses may contain anything; the fields after
  // it start with the state and then the parent's pid.
  int32_t end = stat.RFindChar(')');
  char state;
  int ppid = 0;
  if (end < 0 || sscanf(stat.get() + end + 1, " %c %d", &state, &ppid) != 2) {
    return 0;
  }
  return ppid;
}

bool IsOwnProcess(int aPid) {
  const int self = getpid();
  for (int pid = aPid; pid > 1;) {
    if (pid == self) {
      return true;
    }
    pid = ParentPid(pid);
  }
  return false;
}

// Processes in aCgroup. Fails if any of them is not this process or one of
// its descendants, unless aOnlyOwn is false.
bool ProcessesIn(const nsACString& aCgroup, nsTArray<uint32_t>& aPids,
                 bool aOnlyOwn) {
  nsAutoCString procs;
  if (!ReadFile(PromiseFlatCString(aCgroup + "/cgroup.procs"_ns).get(),
                procs)) {
    return false;
  }
  for (const auto& line : procs.Split('\n')) {
    nsresult rv;
    uint32_t pid = line.ToUnsignedInteger(&rv);
    if (NS_FAILED(rv)) {
      continue;
    }
    if (IsOwnProcess(int(pid))) {
      aPids.AppendElement(pid);
    } else if (aOnlyOwn) {
      return false;
    }
  }
  return true;
}

// Priorities are only set for the parent, content processes and the GPU
// process. A content process may still show the fork server's command line
// right after it was forked, so the priority decides, not the process type.
Leaf LeafForPriority(int aPid, ProcessPriority aPriority) {
  if (aPid == getpid() || ProcessType(aPid).EqualsLiteral("gpu")) {
    return Leaf::Ui;
  }
  return aPriority == PROCESS_PRIORITY_BACKGROUND ||
                 aPriority == PROCESS_PRIORITY_PREALLOC
             ? Leaf::Background
             : Leaf::Foreground;
}

// For processes that have not been given a priority.
Leaf LeafForUnassigned(int aPid) {
  if (aPid == getpid()) {
    return Leaf::Ui;
  }
  nsAutoCString type = ProcessType(aPid);
  if (type.EqualsLiteral("tab")) {
    return Leaf::Foreground;
  }
  if (type.EqualsLiteral("gpu")) {
    return Leaf::Ui;
  }
  return Leaf::Helpers;
}

void MoveTo(int aPid, Leaf aLeaf) {
  nsPrintfCString procs("%s/%s/cgroup.procs", sRoot->get(), LeafName(aLeaf));
  if (!WriteFile(procs.get(), nsPrintfCString("%d", aPid))) {
    HAL_LOG("LinuxProcessPriority - moving %d to %s failed: %s\n", aPid,
            LeafName(aLeaf), strerror(errno));
  }
}

void SetCgroupValue(Leaf aLeaf, const char* aFile, const nsACString& aValue) {
  nsPrintfCString path("%s/%s/%s", sRoot->get(), LeafName(aLeaf), aFile);
  if (!WriteFile(path.get(), aValue)) {
    HAL_LOG("LinuxProcessPriority - writing %s failed: %s\n", path.get(),
            strerror(errno));
  }
}

// A new process starts in the group of the process that forks it: "ui" for
// the parent's children, including the fork server. Move processes that never
// get a priority of their own (the fork server, socket, RDD, utility) to
// "helpers", along with anything left in the cgroup we were started in.
void SweepUnassigned() {
  nsTArray<uint32_t> pids;
  if (ProcessesIn(nsPrintfCString("%s/ui", sRoot->get()), pids,
                  /* aOnlyOwn */ false)) {
    for (uint32_t pid : pids) {
      Leaf leaf = LeafForUnassigned(int(pid));
      if (leaf != Leaf::Ui) {
        MoveTo(int(pid), leaf);
      }
    }
  }
  if (sLaunchCgroup) {
    pids.Clear();
    if (!ProcessesIn(*sLaunchCgroup, pids, /* aOnlyOwn */ false) ||
        pids.IsEmpty()) {
      sLaunchCgroup = nullptr;
      return;
    }
    for (uint32_t pid : pids) {
      MoveTo(int(pid), LeafForUnassigned(int(pid)));
    }
  }
}

void Disable(const char* aReason) {
  HAL_LOG("LinuxProcessPriority - cgroup roles disabled: %s\n", aReason);
  sState = State::Off;
  sPending = nullptr;
}

// Sets up the child groups of aRoot, the scope delegated to us that holds this
// process and its children, and moves the processes into them.
void UseDelegatedCgroup(const nsACString& aRoot) {
  sRoot = new nsCString(aRoot);
  ClearOnShutdown(&sRoot);

  for (Leaf leaf :
       {Leaf::Ui, Leaf::Foreground, Leaf::Background, Leaf::Helpers}) {
    nsPrintfCString dir("%s/%s", sRoot->get(), LeafName(leaf));
    if (mkdir(dir.get(), 0755) != 0 && errno != EEXIST) {
      Disable("cannot create child groups");
      return;
    }
  }

  // Controllers can only be enabled for the child groups once no process is
  // left in the delegated cgroup itself.
  nsTArray<uint32_t> pids;
  if (!ProcessesIn(aRoot, pids, /* aOnlyOwn */ true)) {
    Disable("the delegated cgroup holds other processes");
    return;
  }
  for (uint32_t pid : pids) {
    Maybe<ProcessPriority> priority = sPending->MaybeGet(pid);
    MoveTo(int(pid), priority ? LeafForPriority(int(pid), *priority)
                              : LeafForUnassigned(int(pid)));
  }

  for (const char* controller : {"+cpu", "+memory"}) {
    nsPrintfCString control("%s/cgroup.subtree_control", sRoot->get());
    if (!WriteFile(control.get(), nsDependentCString(controller))) {
      HAL_LOG("LinuxProcessPriority - enabling %s failed: %s\n", controller,
              strerror(errno));
    }
  }

  using namespace StaticPrefs;
  SetCgroupValue(
      Leaf::Ui, "cpu.weight",
      nsPrintfCString(
          "%u", dom_ipc_processPriorityManager_linuxCgroups_uiCpuWeight()));
  SetCgroupValue(
      Leaf::Background, "cpu.weight",
      nsPrintfCString(
          "%u",
          dom_ipc_processPriorityManager_linuxCgroups_backgroundCpuWeight()));
  SetCgroupValue(
      Leaf::Ui, "memory.low",
      nsPrintfCString(
          "%" PRIu64,
          uint64_t(dom_ipc_processPriorityManager_linuxCgroups_uiMemoryLowMB())
              << 20));

  sState = State::Ready;
  HAL_LOG("LinuxProcessPriority - cgroup roles in %s\n", sRoot->get());

  // Processes that were assigned a priority during setup and were not yet
  // in the delegated cgroup.
  for (const auto& entry : *sPending) {
    if (!pids.Contains(entry.GetKey())) {
      MoveTo(int(entry.GetKey()),
             LeafForPriority(int(entry.GetKey()), entry.GetData()));
    }
  }
  sPending = nullptr;
  SweepUnassigned();
}

#ifdef MOZ_ENABLE_DBUS
// Waits for systemd to have moved this process into the new scope.
void WaitForScope(const nsCString& aCgroup, uint32_t aAttempts) {
  nsAutoCString current;
  if (CgroupOf(getpid(), current) && current == aCgroup) {
    UseDelegatedCgroup(aCgroup);
    return;
  }
  if (!aAttempts) {
    Disable("the new scope did not start");
    return;
  }
  nsresult rv = NS_DelayedDispatchToCurrentThread(
      NS_NewRunnableFunction("LinuxProcessPriority::WaitForScope",
                             [aCgroup, aAttempts] {
                               WaitForScope(aCgroup, aAttempts - 1);
                             }),
      20);
  if (NS_FAILED(rv)) {
    Disable("cannot wait for the new scope");
  }
}

// Asks the systemd user manager for a transient scope with Delegate=yes, in
// the nearest slice above our cgroup, holding this process. When Waterfox
// restarts itself, that cgroup is a group of the previous instance's scope.
// Child processes started by then are moved from there afterwards: handing
// them to systemd fails the whole request if one exits in the meantime.
void StartDelegatedScope(const nsACString& aCurrent) {
  nsAutoCString parent(aCurrent);
  nsDependentCSubstring slice;
  while (true) {
    int32_t slash = parent.RFindChar('/');
    if (slash <= 0) {
      Disable("not in a systemd slice");
      return;
    }
    parent.SetLength(slash);
    slice.Rebind(parent, parent.RFindChar('/') + 1);
    if (StringEndsWith(slice, ".slice"_ns)) {
      break;
    }
  }

  sLaunchCgroup = new nsCString(aCurrent);
  ClearOnShutdown(&sLaunchCgroup);

  nsAutoCString name;
  name.AppendPrintf("app-%s-%d.scope", program_invocation_short_name,
                    getpid());
  nsCString cgroup = parent + "/"_ns + name;

  GVariantBuilder pids;
  g_variant_builder_init(&pids, G_VARIANT_TYPE("au"));
  g_variant_builder_add(&pids, "u", uint32_t(getpid()));
  GVariantBuilder properties;
  g_variant_builder_init(&properties, G_VARIANT_TYPE("a(sv)"));
  g_variant_builder_add(&properties, "(sv)", "Description",
                        g_variant_new_string(program_invocation_short_name));
  g_variant_builder_add(&properties, "(sv)", "PIDs",
                        g_variant_builder_end(&pids));
  g_variant_builder_add(&properties, "(sv)", "Delegate",
                        g_variant_new_boolean(true));
  g_variant_builder_add(&properties, "(sv)", "CollectMode",
                        g_variant_new_string("inactive-or-failed"));
  g_variant_builder_add(&properties, "(sv)", "Slice",
                        g_variant_new_string(PromiseFlatCString(slice).get()));
  // The scope has to pass the protection on to "ui".
  if (uint32_t lowMB = StaticPrefs::
          dom_ipc_processPriorityManager_linuxCgroups_uiMemoryLowMB()) {
    g_variant_builder_add(&properties, "(sv)", "MemoryLow",
                          g_variant_new_uint64(uint64_t(lowMB) << 20));
  }
  RefPtr<GVariant> args = dont_AddRef(g_variant_ref_sink(
      g_variant_new("(ssa(sv)a(sa(sv)))", name.get(), "fail", &properties,
                    nullptr)));

  widget::CreateDBusProxyForBus(
      G_BUS_TYPE_SESSION,
      GDBusProxyFlags(G_DBUS_PROXY_FLAGS_DO_NOT_LOAD_PROPERTIES |
                      G_DBUS_PROXY_FLAGS_DO_NOT_CONNECT_SIGNALS |
                      G_DBUS_PROXY_FLAGS_DO_NOT_AUTO_START),
      nullptr, "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager")
      ->Then(
          GetMainThreadSerialEventTarget(), __func__,
          [args, cgroup](RefPtr<GDBusProxy>&& aProxy) {
            widget::DBusProxyCall(aProxy, "StartTransientUnit", args,
                                  G_DBUS_CALL_FLAGS_NONE, 5000)
                ->Then(
                    GetMainThreadSerialEventTarget(), __func__,
                    [cgroup](RefPtr<GVariant>&&) {
                      WaitForScope(cgroup, 100);
                    },
                    [](GUniquePtr<GError>&& aError) {
                      HAL_LOG("LinuxProcessPriority - StartTransientUnit: %s\n",
                              aError->message);
                      Disable("systemd did not create a scope");
                    });
          },
          [](GUniquePtr<GError>&& aError) {
            HAL_LOG("LinuxProcessPriority - systemd user manager: %s\n",
                    aError->message);
            Disable("no systemd user manager");
          });
}
#endif

void StartCgroupRoles() {
  if (!StaticPrefs::dom_ipc_processPriorityManager_linuxCgroups_enabled()) {
    Disable("turned off");
    return;
  }
#ifdef MOZ_ENABLE_DBUS
  nsAutoCString current;
  if (!CgroupOf(getpid(), current)) {
    Disable("no cgroup v2 hierarchy");
    return;
  }
  StartDelegatedScope(current);
#else
  Disable("built without D-Bus");
#endif
}

// The parent process sets its own priority while XPCOM starts up, before the
// profile's preferences are read.
class ProfileObserver final : public nsIObserver {
 public:
  NS_DECL_ISUPPORTS

  NS_IMETHOD Observe(nsISupports*, const char*, const char16_t*) override {
    if (nsCOMPtr<nsIObserverService> os = services::GetObserverService()) {
      os->RemoveObserver(this, "profile-after-change");
    }
    StartCgroupRoles();
    return NS_OK;
  }

 private:
  ~ProfileObserver() = default;
};

NS_IMPL_ISUPPORTS(ProfileObserver, nsIObserver)

void StartCgroupRolesAfterProfile() {
  sState = State::Starting;
  sPending = new nsTHashMap<uint32_t, ProcessPriority>();
  ClearOnShutdown(&sPending);

  nsCOMPtr<nsIObserverService> os = services::GetObserverService();
  nsCOMPtr<nsIObserver> observer = new ProfileObserver();
  if (!os ||
      NS_FAILED(os->AddObserver(observer, "profile-after-change", false))) {
    Disable("cannot wait for the profile");
  }
}

void SetCgroupRole(int aPid, ProcessPriority aPriority) {
  MOZ_ASSERT(NS_IsMainThread());
  if (sState == State::Unset) {
    if (aPid == getpid() && aPriority == PROCESS_PRIORITY_PARENT_PROCESS) {
      StartCgroupRolesAfterProfile();
    }
    return;
  }
  if (sState == State::Starting) {
    sPending->InsertOrUpdate(uint32_t(aPid), aPriority);
  } else if (sState == State::Ready) {
    SweepUnassigned();
    MoveTo(aPid, LeafForPriority(aPid, aPriority));
  }
}

}  // namespace

void SetProcessPriority(int aPid, ProcessPriority aPriority) {
  HAL_LOG("LinuxProcessPriority - SetProcessPriority(%d, %s)\n", aPid,
          ProcessPriorityToString(aPriority));

  uint32_t oomScoreAdj = OomScoreAdjForPriority(aPriority);

  char path[32] = {};
  SprintfLiteral(path, "/proc/%d/oom_score_adj", aPid);

  char oomScoreAdjStr[11] = {};
  SprintfLiteral(oomScoreAdjStr, "%d", oomScoreAdj);

  int fd = open(path, O_WRONLY);
  if (fd >= 0) {
    const size_t len = strlen(oomScoreAdjStr);
    [[maybe_unused]] ssize_t _ = write(fd, oomScoreAdjStr, len);
    (void)close(fd);
  }

  SetCgroupRole(aPid, aPriority);
}

}  // namespace mozilla::hal_impl
