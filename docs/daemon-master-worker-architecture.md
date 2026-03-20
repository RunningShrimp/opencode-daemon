# Daemon Master-Worker Architecture Plan

## Goals

This plan targets two concrete outcomes:

1. Share heavyweight resources across multiple TUI and attach clients whenever sharing does not break project isolation.
2. Make server startup lightweight by moving resource ownership into a dedicated daemon with nginx-like master-worker supervision.

The design is grounded in the current runtime shape and the recent memory findings:

- Multiple entrypoints still resolve through `Instance.provide(..., init: InstanceBootstrap)`.
- `InstanceBootstrap()` still initializes project services such as plugins, LSP, file watchers, VCS, snapshots, truncation, and background service registration.
- Heavy semantic startup has already been made lazy, but the ownership boundary is still process-local rather than daemon-managed.

## Current Runtime Shape

The current codebase has three important characteristics:

### 1. Control plane and project plane are not actually separated

These entrypoints all still bootstrap project state directly:

- `packages/opencode/src/server/server.ts`
- `packages/opencode/src/control-plane/workspace-server/server.ts`
- `packages/opencode/src/cli/bootstrap.ts`
- `packages/opencode/src/cli/cmd/tui/worker.ts`

That means a process that should only route or proxy requests can still become an owner of project resources.

### 2. Project state is already keyed, but it is keyed inside one process

The current `Instance` and `State` abstractions are useful building blocks:

- `packages/opencode/src/project/instance.ts`
- `packages/opencode/src/project/state.ts`

They already give us per-directory state isolation. The problem is that isolation is logical, not architectural. Multiple project states can still accumulate inside the same long-lived process.

### 3. Several expensive resources are attached to instance boot

`InstanceBootstrap()` still initializes or registers:

- plugin hooks
- LSP clients and spawn metadata
- file watchers
- file and VCS helpers
- snapshots
- truncation state
- embedding background service registration

Relevant files:

- `packages/opencode/src/project/bootstrap.ts`
- `packages/opencode/src/lsp/index.ts`
- `packages/opencode/src/file/watcher.ts`
- `packages/opencode/src/plugin/index.ts`
- `packages/opencode/src/ai/rag/embedding-bg-service.ts`

This is lighter than before, but it still means process startup and project ownership are tightly coupled.

## Resource Taxonomy

The key to reducing memory is to stop treating all resources the same.

### Global-shareable resources

These can be owned once by the master daemon and reused by all workers:

- Module installation and native package materialization
  - `packages/opencode/src/util/module-loader.ts`
- Downloaded model artifacts and model registry metadata
  - `packages/opencode/src/provider/models-cache.ts`
- Shared static parser/runtime assets and language package install coordination
  - `packages/opencode/src/util/tree-sitter-scope.ts`
- Global config, auth, provider metadata, migration state, and installation metadata
- Process-wide metrics, health, and memory accounting

These should never be duplicated just because the user opened a second TUI.

### Project-shareable resources

These must stay isolated per project, but they should be shared by all clients attached to the same project:

- LSP client pool
- file watchers
- VCS and snapshot state
- project memory snapshot
- vector store and semantic index
- derived knowledge graph
- project-scoped permissions and caches

Relevant files:

- `packages/opencode/src/lsp/index.ts`
- `packages/opencode/src/file/watcher.ts`
- `packages/opencode/src/snapshot/index.ts`
- `packages/opencode/src/ai/memory/project-memory.ts`
- `packages/opencode/src/ai/rag/vector-store.ts`

These belong in one project worker process, not in each TUI process and not in a generic shared process.

### Session-local resources

These should remain per client session or per active prompt loop:

- active prompt execution state
- streamed token output
- UI state and pagination state
- per-session PTY lifecycle
- approval queues and in-flight tool execution state

These should not pin heavyweight project services in memory after the session is gone.

### Shared runtime services with strict request isolation

These are the highest-value targets for memory reduction, but they need one more boundary:

- embedding model runtime
- GPU or WebGPU context ownership
- optional reranker runtime in the future

These should be moved into dedicated daemon-managed sidecars so that model weights and native GPU allocations are shared across projects, while project data remains in the worker.

## Target Process Topology

### Master daemon

Introduce a dedicated `opencode-master` daemon as the only long-lived owner of global resources.

Responsibilities:

- expose the public local control endpoint
- supervise project workers
- maintain worker registry keyed by canonical project ID and worktree root
- own global caches and artifact stores
- own shared runtime sidecars
- collect RSS, native footprint, and idle timers
- enforce memory budgets and eviction policy

The master must not run `InstanceBootstrap()` for ordinary routing requests.

### Singleton server rule

There must be exactly one local master server instance per user-profile namespace.

That means:

- the first client launch, whether TUI, web helper, attach-capable CLI, or another local frontend, is responsible for ensuring the master exists
- every later client must discover and attach to the existing master instead of starting a second server
- project workers may scale per project, but the public local server process must remain singleton

This is the required fix for the current pattern where different client entrypoints can still create their own server-bearing process trees.

### Client bootstrap behavior

Client bootstrap should change from `start local server for my session` to `ensure master exists, then attach`.

Target behavior:

1. Client checks the local master registry.
2. If the registry points to a healthy master, the client attaches immediately.
3. If no healthy master exists, the client enters a startup election.
4. Exactly one winner starts the master.
5. Losers wait for the master readiness signal, then attach.

Only the first client starts the server. All others become leased clients of that server.

### Discovery and activation protocol

Introduce a local `ServerRegistry` owned by the user profile.

Suggested contents:

- master pid
- startup epoch
- control endpoint
- startedAt timestamp
- auth mode
- namespace
- state: `starting | ready | draining | stopped`

Introduce a separate `ServerBootstrapLock`.

Rules:

- registry read is lock-free
- startup election uses an exclusive bootstrap lock
- lock holder is the only process allowed to spawn the master
- registry is written only after the master control endpoint is reachable
- stale registry entries are reclaimed after pid liveness and health checks fail

### Transport rule

For local clients, default transport should not be an ad hoc per-client HTTP server.

Preferred order:

1. Unix domain socket on macOS/Linux, named pipe on Windows
2. loopback TCP only as compatibility fallback
3. externally reachable HTTP listener only when explicitly requested

This avoids the current failure mode where internal clients accidentally behave like mini-servers.

### Public server vs local control socket

The singleton master should expose two different surfaces:

- `local control socket`
  - always on when the daemon exists
  - used by TUI, CLI, attach, and local frontends
  - singleton only

- `public HTTP listener`
  - optional
  - only enabled by explicit serve/web/expose intent or config
  - routed through the same singleton master, not a second server instance

This keeps the internal operating model stable while still allowing remote/web access when needed.

### Project startup rule

Once the singleton master exists, subsequent client launches must never start a second server.

They may only do one of the following:

- attach to the already running master
- acquire a lease for an existing project worker
- request the master to spawn a missing project worker
- subscribe to project or session event streams

Critically, `worker start` is allowed after the master is up, but `server start` is not.

### Per-project interaction model

The sequence should be:

1. first client starts singleton master
2. master starts zero or more project workers on demand
3. later clients connect to the same master
4. master either reuses an existing project worker or starts one for the requested project
5. client interacts through leased project channels

This satisfies the requirement that only one server instance exists while still allowing many projects and many terminals.

### Failure recovery

Singleton startup needs deterministic crash recovery.

Required checks during discovery:

- does the registry file exist
- is the recorded pid still alive
- does the control endpoint answer health checks
- does the startup epoch in memory match the registry epoch

If any of these checks fail, the registry is treated as stale and a new startup election may occur.

### Namespace rule

By default, there should be exactly one singleton master per user data directory.

Separate masters are only allowed when an explicit namespace override is supplied, for example for:

- development sandboxes
- tests
- isolated enterprise profiles

Without an explicit namespace override, the runtime must not create another master.

### Project worker

Introduce one `opencode-worker` process per canonical project.

Responsibilities:

- own `Instance` context for that project only
- run `InstanceBootstrap()` exactly once for the project lifecycle
- host project routes, session routes, MCP routing, tool execution, LSP, watchers, snapshots, semantic indices, and project memory
- multiplex multiple TUI, web, attach, and workspace sessions for the same project

This turns the current logical keyed state into a real process boundary.

### Client-to-project 1:1 execution model

The correct refinement is not `one client starts one server`, but `one client gets one isolated execution lane under one project`.

That gives three layers:

- singleton master: exactly one per local namespace
- project worker: one per canonical project
- client agent lane: one per attached client session

Under this model:

- multiple clients may still share one project worker for heavy project resources
- each client still gets its own execution lane, prompt loop state, PTY state, approval queue, and temporary runtime state
- no client may directly reuse another client's in-flight execution context

This is the right compromise between memory efficiency and behavioral isolation.

### Why the 1:1 client lane matters

If two clients operate on the same project but share all runtime state, several classes of conflict appear:

- prompt context contamination
- concurrent tool execution interference
- mixed approval state
- PTY cross-talk
- cancellation and retry collisions
- unstable streaming ownership

So the model should be:

- shared project state
- isolated client execution state

Not:

- fully duplicated project workers per client
and not:
- fully shared prompt execution state per project

### Multi-language project rule

Projects may be implemented in different languages, and a single project may also be a multi-language monorepo.

The process model should therefore separate:

- project identity
- client identity
- language-runtime identity

The master and worker registry should support a `ToolchainRuntimeProfile` keyed by values such as:

- projectID
- root path
- language or toolchain kind
- package manager or build system
- environment fingerprint

Examples:

- Node/Bun + TypeScript
- Python + virtualenv/conda
- Rust + cargo
- Go + module root
- Java + Maven/Gradle
- Deno
- polyglot monorepo with multiple subroots

This prevents a Python-oriented runtime decision, environment, or language server from polluting a Rust or Java project, even when clients are opened concurrently.

### Toolchain isolation model

Inside each project worker, language-aware services should be supervised as toolchain cells.

Suggested identity:

- `toolchainCellID = projectID + root + language + envFingerprint`

Each toolchain cell may own:

- one or more LSP servers
- formatter/diagnostic subprocesses
- language-specific symbol index helpers
- environment activation metadata

Toolchain cells are project-scoped, not client-scoped.

That means:

- clients share language infrastructure when they are attached to the same project
- clients do not share their interactive execution state
- toolchain cells from one project never serve another project

### Four-project, four-client concurrent scenario

Consider the following concrete case:

- Project A: Rust
- Project B: Rust
- Project C: TypeScript
- Project D: Go
- Client 1 attaches to Project A
- Client 2 attaches to Project B
- Client 3 attaches to Project C
- Client 4 attaches to Project D

The correct runtime topology is:

- 1 singleton master
- 4 project workers
- 4 client lanes
- 4 primary toolchain cells

The important detail is that the two Rust projects do not share one Rust runtime cell.

They may share only global artifacts such as:

- `rust-analyzer` binary distribution
- tree-sitter Rust parser assets
- shared AI runtime and embedding model residency
- global package and artifact caches

But they must not share project-bound state such as:

- rust-analyzer process state
- Cargo workspace discovery results
- project environment snapshot
- project watcher graph
- project vector and knowledge indices

So the concrete ownership should look like:

- `opencode-project-worker:projectA`
  - `client-lane:client1`
  - `toolchain-cell:projectA:rust`
- `opencode-project-worker:projectB`
  - `client-lane:client2`
  - `toolchain-cell:projectB:rust`
- `opencode-project-worker:projectC`
  - `client-lane:client3`
  - `toolchain-cell:projectC:typescript`
- `opencode-project-worker:projectD`
  - `client-lane:client4`
  - `toolchain-cell:projectD:go`

This is the minimum safe isolation shape.

### What may be shared in that scenario

Across the four projects, the system may safely share:

- singleton master control plane
- local server registry and bootstrap lock
- shared AI runtime sidecar
- language parser packages and global binaries
- model download caches and module installation caches
- tree-sitter wasm assets

Across projects, the system must not share:

- language-server process instances
- project environment baselines
- project memory snapshots
- semantic vector indices
- knowledge graph state
- watcher subscriptions
- VCS state caches

Across clients, the system must not share:

- prompt orchestration state
- pending approvals
- active PTY ownership
- abort and retry chains
- transient task state

### Why the two Rust projects still need two Rust cells

Two Rust projects often look superficially shareable because they use the same language server and the same toolchain.

In practice they still differ on:

- workspace members
- Cargo features
- target directory contents
- rust-toolchain pinning
- environment overrides
- generated sources and build scripts

So the right rule is:

- share Rust artifacts globally
- isolate Rust analysis processes per project

The same rule applies to TypeScript, Go, Python, Java, and others.

### Scheduling consequences in that scenario

When the four clients are active simultaneously:

- the master schedules 4 workers independently
- each worker owns one primary toolchain cell
- each client lane schedules work only inside its own project worker
- the AI runtime sidecar serves all four workers as a shared downstream runtime

This means semantic embeddings may be shared at the model-runtime level, while language analysis remains project-local.

### Idle and recovery behavior in that scenario

If Client 3 disconnects from the TypeScript project:

- only `client-lane:client3` is released immediately
- `projectC` worker may remain warm-idle for reuse
- `toolchain-cell:projectC:typescript` may be downgraded, paused, or torn down according to idle policy
- Rust and Go projects are unaffected

If the Go toolchain cell crashes:

- restart only `toolchain-cell:projectD:go`
- do not restart the Rust or TypeScript workers
- do not disturb clients 1, 2, or 3

This is the failure-domain behavior the system should preserve.

### Process tree

The target process tree should look like this:

1. `opencode-master`
2. `opencode-project-worker:<projectID>`
3. `opencode-client-agent:<clientID>`
4. `opencode-toolchain-cell:<projectID>:<language-root>`
5. language-specific child processes such as LSP/debug/build helpers

Operationally:

- master supervises project workers
- project worker supervises client agents and toolchain cells
- toolchain cell supervises language-native subprocesses

This gives clear ownership and deterministic teardown.

### Responsibility split inside a project worker

The project worker should own the shared project plane:

- file watcher graph
- snapshot state
- VCS state
- vector index
- knowledge graph
- project memory
- toolchain cell registry

The client agent lane should own the per-client plane:

- prompt orchestration
- model call streaming
- task graph state
- approval state
- session-local PTY routing
- abort controllers
- temporary working buffers

This is the actual isolation boundary the runtime must enforce.

### Client lane lifecycle

Each attached client gets one `ClientAgentLease` and one `ClientAgentProcess` or equivalent isolated lane.

States:

- `created`
- `attached`
- `active`
- `idle`
- `draining`
- `released`

Rules:

- client lane shutdown must not tear down the project worker if other leases still exist
- client lane crash must be recoverable without recycling the whole project worker
- client lane cancellation must only affect that client's in-flight operations

### Isolation levels

The runtime should support explicit isolation levels.

Recommended levels:

- `shared-project`
  - shared project worker, isolated client lane
- `strict-client`
  - dedicated client lane plus exclusive PTY/debug/build subprocess ownership
- `strict-worker`
  - dedicated worker for one client when maximum isolation is required

Default should be `shared-project`.

`strict-worker` should be reserved for debugging, enterprise policy, or high-risk tasks, because it trades memory for isolation.

### Environment isolation

For projects written in different languages, each project worker must hold its own immutable environment snapshot.

This snapshot should include:

- cwd and canonical worktree
- resolved PATH view
- detected toolchain binaries
- virtualenv/conda metadata for Python
- package manager metadata for Node/Bun/Deno
- cargo/go/maven/gradle root markers
- relevant environment overrides

Client lanes may inherit this snapshot, but may not mutate the project-wide baseline.

This prevents one client or one tool invocation from mutating the environment seen by another client.

### Process management rules

Process management must follow ownership strictly.

#### Master may manage

- singleton lifecycle
- worker spawn/stop/restart
- global budget enforcement
- stale worker cleanup

#### Project worker may manage

- client lane spawn/release
- toolchain cell spawn/release
- project-scoped subprocess cleanup
- language service backoff and restart

#### Client lane may manage

- its own PTY children
- its own task subprocesses
- its own cancellation and timeout tree

No lower layer may directly terminate sibling-owned processes.

### Language-aware restart policy

Not all subprocesses should be restarted the same way.

Recommended policy:

- LSP process crash: restart only the affected toolchain cell
- build/test shell crash: fail only the owning client lane
- project worker crash: reconnect clients through master and rebuild project plane
- master crash: full singleton recovery path via registry and startup election

This keeps language-specific failures from escalating into global outages.

### Monorepo and mixed-language support

For monorepos, a single project worker may host multiple toolchain cells simultaneously.

Examples:

- frontend TypeScript cell
- backend Go cell
- services Python cell
- infra Nix or Terraform cell

The key rule is:

- one project worker may host many language cells
- one client lane may talk to many language cells
- one language cell may never cross project boundaries

### Scheduling rule

When a client request arrives, scheduling should happen in this order:

1. resolve singleton master
2. resolve project worker
3. resolve client lane
4. resolve required toolchain cell
5. run the task in the narrowest possible owner

This keeps the heavy shared state high in the tree and the volatile interactive state low in the tree.

### Shared AI runtime sidecar

Introduce one `opencode-ai-runtime` process managed by master.

Responsibilities:

- own heavyweight embedding model runtime
- own GPU or WebGPU adapter selection and lifecycle
- maintain a bounded model residency pool
- serve inference requests over local IPC

Project workers send text or chunk payloads and receive embeddings back. They do not own model weights, GPU contexts, or native inference allocations.

This is the single most important change for reducing duplicate `MALLOC_LARGE` and GPU-native allocations across multiple project workers.

## Request Flow

### TUI and CLI flow

1. Client connects to master.
2. Master resolves canonical project identity from directory or worktree.
3. Master returns an existing worker lease or spawns a new worker.
4. Client traffic is proxied to that worker.
5. Worker performs lazy activation of project resources on first use.

Before step 1, the client must first execute the singleton bootstrap protocol:

1. discover existing master
2. if found, attach
3. if not found, participate in startup election
4. only the winner starts the master
5. all clients then continue against that same master

### Workspace flow

`workspace-serve` should stop creating project state itself.

Instead:

1. Master owns workspace registration and event fanout.
2. Workspace identity maps to an existing project worker plus a workspace lease.
3. Worker handles project-specific session APIs.
4. Master handles heartbeat, connection lifecycle, and worker discovery.

This removes the current duplication where `WorkspaceServer.App()` still enters `Instance.provide(..., init: InstanceBootstrap)`.

## Sharing Strategy

### Layer A: share artifacts, not runtime state

This is the lowest-risk immediate gain.

Master owns:

- module installation locks
- model download locks
- tree-sitter language download locks
- static models metadata cache
- global cache directories and cleanup policy

Workers only receive resolved paths and ready-to-use artifacts.

### Layer B: share heavyweight runtime engines

This is the highest-value memory gain.

The AI runtime sidecar owns:

- embedding model process
- tokenizer/model residency
- GPU adapter choice
- runtime warm pool

Workers keep:

- vector storage
- project chunking
- retrieval logic
- index lifecycle
- evidence assembly

This preserves project isolation while centralizing the expensive native runtime.

### Layer C: share one project worker across many clients

This is required for a good multi-TUI experience.

For the same project:

- one worker
- many client sessions
- one LSP pool
- one watcher set
- one project memory state
- one vector index state

This removes the current pattern where opening multiple interfaces can repeat project initialization.

## Worker Lifecycle Model

Use nginx-like supervision, but adapted for stateful project workers.

### Worker states

- `cold`: no worker process exists
- `starting`: worker spawned, bootstrap running
- `hot`: active sessions or recent activity
- `warm-idle`: no active sessions, caches kept resident for short reuse window
- `draining`: no new leases, waiting for in-flight work to finish
- `terminated`: process exited and resources released

### Idle policy

Apply staged shedding instead of immediate process kill:

1. stop file watchers for inactive projects
2. stop idle LSP clients
3. flush vector/project-memory snapshots to disk
4. drop worker-local caches
5. terminate worker after idle timeout if no lease remains

The master decides this using actual memory and idle time, not just process count.

## Memory Budgeting

The master should own budgeting instead of leaving each process to infer pressure locally.

### Global budgets

- total daemon RSS budget
- total AI runtime native budget
- max resident project workers
- max concurrent hot workers

### Per-worker budgets

- worker RSS target
- LSP process count ceiling
- watcher count ceiling
- vector cache size ceiling
- pending session concurrency ceiling

### Budget actions

When budgets are exceeded, master applies deterministic shedding:

1. evict warm-idle workers
2. unload idle project services inside workers
3. shrink AI runtime model pool
4. reject new prewarm requests
5. force cold start for least-recently-used projects

## API and Runtime Changes

### New internal components

- `MasterDaemon`
- `WorkerSupervisor`
- `ProjectWorkerLeaseRegistry`
- `SharedArtifactRegistry`
- `AIRuntimeSupervisor`
- `WorkerMetricsCollector`

### New internal IPC contracts

- `worker.spawn(projectID, directory, worktree)`
- `worker.acquireLease(projectID, clientID)`
- `worker.releaseLease(projectID, clientID)`
- `worker.stats(projectID)`
- `ai.embed(model, payload, options)`
- `artifact.ensure(moduleOrModel)`

### Existing routes to re-home

- global health and control stay on master
- project and session routes move behind worker routing
- workspace event routing moves to master control plane
- worker no longer exposes public network directly except behind master

## Implementation Plan

### Phase 0: completed foundation

Already done:

- semantic startup work no longer eagerly boots on instance startup
- embedding service is registration-first and use-triggered
- project memory bootstrap is lazy

This phase reduced unnecessary startup work but did not yet fix process topology.

### Phase 1: introduce master without changing business routes

Deliverables:

- add dedicated master process
- move public local server entry to master
- spawn one worker per project
- proxy current project/session routes from master to worker
- remove direct `InstanceBootstrap()` from workspace control-plane server

Expected result:

- lightweight server startup
- one project worker reused across multiple TUI clients
- no duplicate project boot inside control-plane processes

### Phase 2: move global artifact ownership into master

Deliverables:

- central module install coordination
- central model artifact coordination
- central tree-sitter package coordination
- central cache cleanup and quota enforcement

Expected result:

- fewer redundant installs and duplicate cache warmups
- cleaner worker startup path

### Phase 3: extract embedding runtime into shared sidecar

Deliverables:

- local IPC for embedding inference
- shared GPU and native runtime ownership
- bounded model residency pool
- worker-side fallback path if sidecar is unavailable

Expected result:

- biggest multi-project memory reduction
- far better behavior when several TUIs use semantic retrieval concurrently

### Phase 4: worker service shedding and adaptive lifecycle

Deliverables:

- staged unloading of LSP, watchers, and caches
- idle-to-cold transition policy
- master-owned memory and pressure telemetry

Expected result:

- better steady-state memory behavior under long-lived multi-project usage

## Migration Rules

To keep the rollout safe, hold these rules:

1. No new control-plane endpoint may call `InstanceBootstrap()` directly.
2. No global process may own project watchers, project LSP clients, or project vector state.
3. No project worker may own embedding model weights once the shared runtime sidecar exists.
4. All expensive startup paths must be demand-driven, measurable, and externally supervised.

## Recommended First Code Changes

The highest-leverage implementation sequence is:

1. Introduce `MasterDaemon` and route `serve`, `web`, `attach`, and TUI attachment through it.
2. Convert current server internals into a worker app that assumes exactly one project context for its process lifetime.
3. Remove project boot from `workspace-server` and make it a pure control-plane API.
4. Add worker lease tracking and idle shutdown.
5. Extract embedding runtime into a sidecar after worker reuse is stable.

## Expected Outcome

If implemented in this order, the system should gain:

- much lighter server startup
- one shared project worker per project instead of duplicated per-client project state
- one shared embedding runtime instead of duplicated model and GPU allocations
- better multi-project fairness under constrained memory
- fewer cross-project conflicts because state ownership becomes explicit at the process level

This is the path that best matches the recent memory findings while preserving the existing project-scoped abstractions already present in `Instance` and `State`.

## Control Plane And Data Plane Separation

The next architectural step is not only process separation, but traffic separation.

At the moment, several paths still mix coordination and payload transport:

- `packages/opencode/src/control-plane/workspace-router-middleware.ts` forwards full requests through workspace routing because sync is not separated yet.
- `packages/opencode/src/control-plane/workspace-server/routes.ts` and `packages/opencode/src/server/routes/global.ts` both use broad SSE event channels.
- `packages/opencode/src/bus/global.ts` exposes one generic event emitter with no hard distinction between topology events and payload events.

That keeps the runtime easy to evolve incorrectly, because once a generic channel exists, large state and chat payloads inevitably leak onto it.

### Control plane definition

The control plane should only carry information needed to decide where work runs and how processes are managed.

Allowed control-plane traffic:

- client registration and lease acquisition
- worker spawn, stop, drain, and restart
- health, heartbeat, readiness, and backpressure
- memory budget and eviction commands
- workspace-to-project resolution
- capability discovery and version negotiation
- subscription registration for project or session streams

Forbidden control-plane traffic:

- full message history
- prompt parts and attachment bodies
- embeddings and vector payloads
- file contents and patch bodies
- semantic index chunks
- large tool outputs

### Data plane definition

The data plane should carry session payloads, file payloads, retrieval payloads, and model payloads after routing is already resolved.

Allowed data-plane traffic:

- session prompt input and streamed output
- message parts and history deltas
- PTY bytes
- file reads, patches, and snapshots
- retrieval requests and results
- embedding inference requests and vectors
- tool call input and tool output

Forbidden data-plane responsibilities:

- worker lifecycle decisions
- cross-project worker registry mutation
- memory budget policy
- workspace routing decisions

### Proposed topology

Use three distinct channels:

1. `control rpc`
  - master <-> clients
  - master <-> workers
  - master <-> ai runtime
  - small JSON messages only

2. `project data stream`
  - clients <-> project worker via master proxy or direct leased socket
  - session and project payloads only

3. `ai inference stream`
  - project worker <-> ai runtime sidecar
  - embedding and model-runtime payloads only

This means the master no longer needs to parse, buffer, or retain project payloads once routing is complete.

### Event model changes

Current `GlobalBus` should evolve into two categories:

- `ControlBus`
  - worker started
  - worker drained
  - worker pressure
  - workspace attached
  - workspace detached
  - runtime sidecar ready

- `ProjectEventStream`
  - session created
  - session updated
  - message delta
  - pty updated
  - file watcher changed
  - worktree ready

Rule:

Global control streams may reference `projectID`, `workspaceID`, `sessionID`, and counters, but must not carry large payload fields.

### Routing rule

Master resolves routing once, then gets out of the way.

The intended flow is:

1. Client sends `control.acquireLease(directory, workspaceID?)`.
2. Master resolves canonical project and worker endpoint.
3. Master returns lease metadata and stream endpoints.
4. Client sends prompt/file/tool traffic to the project data plane.
5. Project worker talks to ai runtime over the inference data plane when semantic or model-runtime work is needed.

Only lease renewal, backpressure, drain notices, and failover return to control plane.

An important corollary is that client boot no longer maps to server boot. Client boot maps to `discover-or-attach`, while only a missing master maps to `server boot`.

### Storage ownership rule

Control plane stores metadata only.

Examples:

- worker pid
- worker state
- lease count
- route tokens
- budget counters
- last activity timestamps

Data plane stores or serves payload state.

Examples:

- session rows
- message rows and parts
- snapshots
- vector data
- project memory snapshots
- semantic retrieval evidence

This prevents the master from becoming a second database-shaped process.

### API split

The internal APIs should be split explicitly instead of only by file location.

Suggested control APIs:

- `control.acquireLease`
- `control.releaseLease`
- `control.workerStats`
- `control.workspaceResolve`
- `control.subscribeProject`
- `control.runtimeStatus`

Suggested data APIs:

- `session.prompt`
- `session.command`
- `session.stream`
- `file.read`
- `file.patch`
- `pty.input`
- `retrieval.query`
- `ai.embed`

### Migration constraints

To keep separation real instead of nominal, add these constraints during implementation:

1. No control-plane endpoint may accept raw file bodies, prompt parts, or embedding arrays.
2. No global event emitter may publish message text, tool payloads, or snapshot content.
3. Worker data APIs may not spawn or resolve other workers.
4. The ai runtime sidecar may not access project storage directly; workers remain the only owners of project data.
5. Workspace routing middleware should eventually forward only control metadata and leased stream endpoints, not arbitrary full requests.

### Phase refinement

The original phase plan should be refined as follows:

- Phase 1a: introduce singleton master bootstrap and worker supervision.
- Phase 1b: make all local clients discover-and-attach instead of start-and-serve.
- Phase 1c: split control endpoints from project data endpoints.
- Phase 2a: move global artifact ownership to master.
- Phase 2b: replace generic global event streams with typed control events plus project data streams.
- Phase 3: extract shared ai runtime sidecar.

This makes control/data separation a first-class rollout objective instead of an incidental byproduct of master-worker adoption.