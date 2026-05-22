# kagent-mcp-server Template — Pre-Implementation Lookups

Task 0 of the kagent-mcp-server scaffolder template plan. Records the
verified values needed by later tasks (specifically Task 3b for stdio
presets and Task 4a/4b for the HTTP github-mcp-server preset and the
ExternalSecret store reference).

Date verified: 2026-05-22
Verifier: arigsela@gmail.com (via Claude Code)
Worktree: /Users/arisela/git/backstage/.worktrees/feat-kagent-mcp-server
Branch: feat/kagent-mcp-server-template

---

## github-mcp-server entrypoint

Source: `docker pull` + `docker inspect ghcr.io/github/github-mcp-server:latest`
(image digest `sha256:e3816a476a977cfb836e7d221510011436c654d11861db66ecfd826601aba6a4`).

Verbatim from `docker inspect ... --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}'`:

```
ENTRYPOINT: ["/server/github-mcp-server"]
CMD:        ["stdio"]
HTTP flag:  "http" subcommand (overrides default CMD "stdio"); HTTP port via "--port <int>" (default 8082)
```

### How HTTP mode is enabled

The image's default CMD is `["stdio"]`, which starts the stdio MCP server.
To run the HTTP (streamable_http) variant, the container's command must be
overridden to invoke the `http` subcommand. The relevant `--help` output:

```
Available Commands:
  http          Start HTTP server
  stdio         Start stdio server
  ...

server http [flags]
  --base-path string   Externally visible base path (OAuth resource metadata)
  --base-url string    Base URL where this server is publicly accessible
  --port int           HTTP server port (default 8082)
  --scope-challenge    Enable OAuth scope challenge responses
```

### Resulting kmcp `MCPServer` shape for the HTTP preset

Because the entrypoint is fixed (`/server/github-mcp-server`), kmcp's
container override needs to supply `cmd` = the entrypoint binary and
`args` = the subcommand + any extra flags. Recommended values for
Task 4a fixtures / Task 4b template:

```yaml
cmd: /server/github-mcp-server
args:
  - http
  - --port=8080         # match the MCPServer service port we expose
# Optional flags worth surfacing later if needed:
#   --toolsets=default  (or "all" / explicit subset)
#   --read-only         (lockdown-style template variant)
```

Note: Port `8080` is the convention used in kagent example MCPServers; we
explicitly override the image default of 8082 to keep our wizard config
consistent. The plan should reflect this in the rendered fixture.

References:
- `docker inspect ghcr.io/github/github-mcp-server:latest` (local pull, 2026-05-22)
- `docker run --rm ghcr.io/github/github-mcp-server:latest --help`
- `docker run --rm ghcr.io/github/github-mcp-server:latest http --help`
- Upstream README: https://github.com/github/github-mcp-server/blob/main/README.md

---

## ClusterSecretStore

> ⚠️ **Material deviation from the original plan assumption.**
> The cluster does **not** use a `ClusterSecretStore`. Verified via:
>
> ```
> $ kubectl get clustersecretstore -o name
> No resources found
> ```
>
> Vault-backed `ExternalSecret`s in this cluster reference a **namespaced
> `SecretStore` named `vault-backend`**, one per consuming namespace. The
> rendered `ExternalSecret` (Task 4b) must therefore use:
>
> ```yaml
> secretStoreRef:
>   kind: SecretStore          # NOT ClusterSecretStore
>   name: vault-backend
> ```
>
> …assuming MCPServers will be deployed into the `kagent` namespace
> (which already has its own `vault-backend` SecretStore).

```
Name:        vault-backend  (namespaced kind: SecretStore, NOT ClusterSecretStore)
Namespace:   kagent  (one vault-backend SecretStore lives in each consuming namespace; same pattern across cluster)
Provider:    vault @ http://vault.vault.svc.cluster.local:8200
Vault path:  k8s-secrets (kv v2)
Vault role:  kagent (kubernetes auth, mountPath kubernetes, SA "default")
Verified via:
  - kubectl get clustersecretstore -o name        -> "No resources found"
  - kubectl get secretstore -A                    -> vault-backend exists in 19 namespaces incl. kagent + backstage
  - kubectl get -n backstage externalsecret -o yaml | grep secretStoreRef
      -> kind: SecretStore, name: vault-backend
  - kubectl get -n kagent secretstore vault-backend -o jsonpath=...
      -> http://vault.vault.svc.cluster.local:8200, path=k8s-secrets, role=kagent
  - GitOps cross-ref: arigsela/kubernetes @ base-apps/kagent/secret-store.yaml
      (kind: SecretStore, metadata.name: vault-backend, metadata.namespace: kagent)
  - GitOps cross-ref: arigsela/kubernetes @ base-apps/kagent/external-secrets.yaml
      (kagent-db-credentials uses kind: SecretStore, name: vault-backend)
```

### Impact on later tasks

- **Task 4b (externalsecret.yaml template):** Hardcode `kind: SecretStore`
  and `name: vault-backend`. Do not introduce a wizard parameter for
  store kind/name unless the user wants to support cross-namespace
  deployments later. The store name is namespace-local, so as long as
  MCPServers land in `kagent`, this is correct.
- **Plan section that references `ClusterSecretStore`:** update wording
  to "namespaced SecretStore named vault-backend in the target
  namespace" when Task 4b is implemented. (Out of scope for Task 0 —
  recorded here for traceability.)
- If a future MCPServer needs to deploy into a namespace that has no
  `vault-backend` SecretStore yet, the bootstrap of that SecretStore is
  a GitOps concern (handled in the `arigsela/kubernetes` repo), not a
  scaffolder concern.
