# NH-038 Sandbox execution contract

Status: boundary contract only. This task does **not** implement or claim production-grade process, container, microVM, VM, kernel, filesystem, cgroup, seccomp, namespace, or network isolation.

The contract exists so M06 callers and a future sandbox executor agree on the request/result boundary before any concrete isolation backend is selected.

## Request

`contract_version` is `nh.sandbox.v1` and `kind` is `request`.

`command` uses `executable + argv + cwd`, not a shell command string. `cwd` is lexically constrained to the sandbox workspace. An executor must preserve argv semantics and must not silently reinterpret it through a shell.

`limits` is explicit and uses fixed units:

- `cpu_millis`: total CPU-time budget in milliseconds.
- `memory_bytes`: peak memory budget in bytes.
- `wall_time_ms`: elapsed wall-clock timeout in milliseconds.
- `disk_bytes`: writable sandbox/workspace budget in bytes, including produced artifacts.

`network.mode` is either `DENY_ALL` or `ALLOWLIST`. `DENY_ALL` requires an empty list. `ALLOWLIST` contains exact lowercase host names only; URL paths, schemes and wildcard expansion are intentionally outside this contract. This is policy data, not a packet filter. A production executor must enforce the policy below the untrusted process and must separately defend platform-internal addresses, cloud metadata and credential services.

`artifacts` declares allowed output paths, whether each path is required, and its per-artifact maximum size. Paths are canonical POSIX-style paths relative to the workspace root. Absolute paths, Windows drive roots, backslashes, empty segments and `.`/`..` traversal are rejected lexically. A real executor must additionally resolve filesystem objects safely and reject symlink/hardlink or mount-based escapes; lexical validation alone is not isolation.

## Result

`kind` is `result`. The result contains measured `usage`, captured declared artifacts, and an `exit` object.

Exit reasons are stable machine-readable values:

- `COMPLETED`
- `NONZERO_EXIT`
- `SIGNALLED`
- `CPU_LIMIT_EXCEEDED`
- `MEMORY_LIMIT_EXCEEDED`
- `TIME_LIMIT_EXCEEDED`
- `DISK_LIMIT_EXCEEDED`
- `NETWORK_DENIED`
- `INVALID_REQUEST`
- `START_FAILED`
- `EXECUTOR_ERROR`

`assertSandboxExecutionResult(result, request)` additionally checks that returned artifacts were declared, required artifacts are present, and returned artifact sizes do not exceed their declared limits.

`classifySandboxExit(request, observation)` only defines deterministic reason mapping for an executor observation. It does not kill processes, meter resources, block network access, or establish any isolation property.

## Security boundary

The system design requires untrusted code to run under isolation that limits CPU, memory, disk, time, and accessible network. The concrete deployment may use hardened containers, microVMs or VMs according to the threat model. NH-038 only fixes the interface and validation vocabulary required by that future executor.
