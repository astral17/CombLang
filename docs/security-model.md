# Security model

The current source executor is an availability-isolated elaboration environment, not a capability-secure sandbox.

The browser runs generated JavaScript in a terminable Worker and enforces a wall-clock timeout. The runtime also limits circuit-recording DSL calls. These measures keep an infinite or excessively productive generator from freezing the editor; they do not guarantee that untrusted source cannot use APIs exposed by the Worker environment. The CLI executes the same elaboration semantics in the local Node process and must likewise be given only trusted source.

Current safe-use assumption: users compile code they authored or explicitly trust. Opening and automatically executing arbitrary shared projects is outside the present security contract.

Before public shared-project execution, the project must revisit global capabilities, networking and storage access, module loading, resource limits, data exfiltration, and host-specific behavior. The fully hardened module sandbox remains Phase 11 work; the optional reproducible-build policy is a separate concern and does not by itself make execution secure.
